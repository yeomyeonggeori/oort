//! The **workspace action registry** — ADR-0186 D1, the Rust side of "정의는 한
//! 곳, 소비자는 셋".
//!
//! A *workspace action* is something that changes the workspace and that an
//! agent may **propose** but never execute: an invite link, a webhook, a
//! channel, a role change. [`ACTIONS`] is the one definition, and three
//! consumers are derived from it rather than written beside it:
//!
//! 1. `GET /v1/workspaces/{ws}/actions` — the human-facing catalog (부록 E);
//! 2. the `actionId` enum of the Agent Port tool `oort_action_propose`;
//! 3. `docs/api/openapi.yaml`'s `WorkspaceActionId`.
//!
//! The second copy is unavoidable: `momo-mcp` is protocol-only and may not
//! depend on this crate (its Cargo.toml says so, and that boundary is what
//! keeps SQL out of the protocol layer). So the enum is written twice and a
//! single drift test measures all three lists at once — see
//! `bins/momo-server/src/routes/actions.rs`'s
//! `the_action_ids_are_one_list_in_three_places`.
//!
//! ## What is deliberately not here
//!
//! * **No executor.** ADR-0186 D2 runs the action inside the *decision*
//!   transaction, with the **approver's** authority, and that half lives in
//!   `bins/momo-server/src/routes/approvals.rs`
//!   (`execute_workspace_action`, AX-3b #2509). An agent is never admin at any
//!   point (D2), so a registry that carried an executor callable from the
//!   agent's own transaction would be the exact shape this ADR rejected.
//! * **No argument normalisation.** The invite spec already has validators
//!   (`momo_settings::{normalized_invite_role, validated_max_uses,
//!   validated_expires_at_ms}`) and this crate does not depend on
//!   `momo-settings`. The server layer reuses them
//!   (`routes::actions::validated_action_args`) rather than growing a second
//!   set here — a second validator is a second answer to "is this a legal
//!   invite", and the two would drift.
//!
//! What this module *does* own is the declaration (id, title, summary, risk,
//! required role, argument schema) and the **card contract** on both sides of a
//! decision — 부록 A's `action` block on the request card, 부록 B's
//! `momo.action_result` on the outcome card — because those must not be able to
//! disagree about what was asked for and what was done.

use serde_json::{json, Value};
use uuid::Uuid;

/// `approval.action_type` for every workspace-action proposal.
///
/// A sibling of [`crate::tools::ACTION_TYPE_TOOL_CALL`] on the same column
/// (ADR-0186 D7: DDL untouched). The decision route branches on this string, and
/// the expiry sweep must **not** — an expiring workspace action settles through
/// exactly the same arm a tool call does, minus the resume job it never had.
pub const ACTION_TYPE_WORKSPACE_ACTION: &str = "workspace_action";

/// `invite.create` — mint a workspace invite link.
///
/// v1's only executable action, and the one the product sentence is about:
/// 「@hermes 초대 링크 하나 만들어줘」 has no path today (ADR-0186 §1.1).
pub const ACTION_INVITE_CREATE: &str = "invite.create";

/// `channel.create` — create a channel as the approver and, in the same
/// transaction, bring the proposing agent into it (ADR-0186 증보 V3).
pub const ACTION_CHANNEL_CREATE: &str = "channel.create";

/// `channel.member.add` — put named members into a channel the proposing agent
/// can see (ADR-0186 증보 V1-b).
pub const ACTION_CHANNEL_MEMBER_ADD: &str = "channel.member.add";

/// ADR-0217: server-raised, one card per other human in this DM.
pub const ACTION_DM_AGENT_ADMIT: &str = "dm.agent.admit";

/// `agent.rename` — change an agent's display name: the proposer's own, or that
/// of another agent of the same owner (ADR-0186 증보 V4 / V4-M).
pub const ACTION_AGENT_RENAME: &str = "agent.rename";

/// `hosted.channels.grant` — widen the **proposing agent's own** hosted
/// connection by channels it can already see (ADR-0186 증보 V5). The one action
/// by which an agent asks for more reach; it is deliberately the narrowest.
pub const ACTION_HOSTED_CHANNELS_GRANT: &str = "hosted.channels.grant";

/// `workspace.settings.update` — change **two** keys of the workspace settings
/// bag, `welcome_prompt` and `role_labels`, and nothing else (ADR-0186 증보 V7).
/// There is no general "set a setting" action; a third key is a new amendment.
pub const ACTION_WORKSPACE_SETTINGS_UPDATE: &str = "workspace.settings.update";

/// `agent.profile.update` — change an agent's profile **card**: the proposer's
/// own or that of an agent of the same owner (V4-M), limited to display name,
/// tagline, status line and role label (ADR-0186 증보 2026-10-13 v3 V3-2).
/// Avatar sources include presets, attachments and generated/retrieved images;
/// `instructions` and everything that steers behaviour are not reachable here.
pub const ACTION_AGENT_PROFILE_UPDATE: &str = "agent.profile.update";

/// `agent.invite` — bring another, external agent into the workspace: the approver
/// (an admin) becomes its owner and gets a one-time pairing code; the connection
/// stays `pairing_pending` and a human still confirms it (ADR-0186 증보 v3 V3-3).
pub const ACTION_AGENT_INVITE: &str = "agent.invite";

/// `workspace.unfurl.update` — turn the workspace's link previews on or off, as
/// `PUT …/unfurl-settings` does (ADR-0201 증보 v2 H6-1). Team AI only.
pub const ACTION_WORKSPACE_UNFURL_UPDATE: &str = "workspace.unfurl.update";

/// `workspace.memory.update` — turn team memory **off** or pause/unpause it, as
/// `PATCH …/memory/settings` does (ADR-0201 증보 v2 H6-1). Turning it **on** is not
/// reachable from a card: switching it on sends channel text to a provider, so an
/// admin reads the team notice (ADR-0196) in settings first. Team AI only.
pub const ACTION_WORKSPACE_MEMORY_UPDATE: &str = "workspace.memory.update";

/// `workspace.work_tier.update` — set the workspace's default work tier policy, as
/// `PUT …/work-tier-policy` does (ADR-0201 증보 v2 H6-1). Team AI only.
pub const ACTION_WORKSPACE_WORK_TIER_UPDATE: &str = "workspace.work_tier.update";

/// `plugin.install` — install one official app into the workspace, as `POST
/// …/plugins/{plugin}/install` does (ADR-0201 증보 v2 H7, opened by #3889 once the
/// install route and its domain function exist, ADR-0113 P3 / #3914). Team AI
/// only (ADR-0201 H6: the helper was asked for this, external agents were not).
/// Approving installs and **enables** the app; connecting it (a grant) is never a
/// card — that is the member's own consent (ADR-0113 D2).
pub const ACTION_PLUGIN_INSTALL: &str = "plugin.install";

/// `team_ai.roles.set` — switch **one** role bundle of the team AI ("oort 도우미") on or off,
/// as `PATCH …/settings` does for `team_ai_roles` (ADR-0201 증보 v3 B3-T, #4964). The one
/// way the helper's reach changes from a chat; helper only, an admin approves, and it is on
/// the sensitive list (`team_ai_roles::SENSITIVE_ACTION_IDS`): a request that has read anything
/// never gets to propose it.
pub const ACTION_TEAM_AI_ROLES_SET: &str = "team_ai.roles.set";

/// `member.role.set` — declared, not executable yet ([`DECLARED_NOT_EXECUTABLE`]). Named here
/// because ADR-0201 증보 v3 B4-3 puts it on the helper's sensitive list before it is ever opened:
/// raising a person's workspace role must never come out of text the helper has read.
pub const ACTION_MEMBER_ROLE_SET: &str = "member.role.set";

/// `host.session.open` — Host Ops (ADR-0210), not in this registry yet. Named here for the same
/// reason as [`ACTION_MEMBER_ROLE_SET`]: the sensitive list (B4-3) is a deny-list, so it can name
/// an id before the action exists and the id is covered the day it is added.
pub const ACTION_HOST_SESSION_OPEN: &str = "host.session.open";

/// The requesting human's own avatar (ADR-0186 v4 + amendment v7, #4791).
/// Sources are their image attachment in this conversation or generated/retrieved
/// image bytes. The run supplies the subject and only that person may approve.
pub const ACTION_MEMBER_AVATAR_SET: &str = "member.avatar.set";

/// The requesting human's own display name (ADR-0186 amendment v7, #4791).
/// The run supplies the subject; neither an argument nor an admin may substitute it.
pub const ACTION_MEMBER_DISPLAY_NAME_SET: &str = "member.display_name.set";

/// `message.pin` — pin one message to the head of the channel it is in, **as the
/// approver**, through the very function a person's own pin uses (ADR-0186 증보 v5 U-e).
/// A pin reads as an endorsement, so an agent never does it unasked.
pub const ACTION_MESSAGE_PIN: &str = "message.pin";

/// `message.unpin` — take a pin off (ADR-0186 증보 v5 U-e). The same gate and the same
/// card as [`ACTION_MESSAGE_PIN`]: clearing a pin is as visible to the channel as setting one.
pub const ACTION_MESSAGE_UNPIN: &str = "message.unpin";

/// `expression.create` — put one picture into the team's expression library after a
/// person looked at the exact stored picture (ADR-0186 증보 v8 / ADR-0218 부록 B). Up to
/// four candidates, one is chosen. Not on [`TEAM_AI_ACTION_IDS`] and not an initiative
/// action: only an external agent a person asked, through `oort_action_propose`.
pub const ACTION_EXPRESSION_CREATE: &str = "expression.create";

/// What a person is consenting to when they approve (ADR-0186 D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    /// Changes nothing on the server — navigation, theme, density. These are
    /// **client** commands (TS registry) and never reach this catalog; the
    /// variant exists because `GET …/actions` publishes a `risk` field whose
    /// vocabulary is the ADR's table, not "whatever v1 happened to need".
    None,
    /// Changes the workspace. Always an approval card, always executed by the
    /// approver's authority.
    Approval,
}

impl Risk {
    pub fn as_wire(self) -> &'static str {
        match self {
            Risk::None => "none",
            Risk::Approval => "approval",
        }
    }
}

/// The workspace role a **decider** must hold for an action to execute.
///
/// Not the agent's role: the agent holds none of these at any point. This is
/// read by the decision route (AX-3b) to judge the approver, and published so a
/// card can say 「관리자가 승인해야 합니다」 before anyone taps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredRole {
    /// A workspace owner/admin (`routes::invites::require_admin`).
    Admin,
    /// The **target agent's** owner, or a workspace admin — the same judgement
    /// `PUT …/agents/{agent}/profile` applies (`require_profile_editor_in_tx`).
    /// Unlike every other role this one is judged against a *subject* the
    /// decision route resolves from the proposal (ADR-0186 증보 V1-c / V4-M), so
    /// it cannot be checked before the arguments are re-proved.
    AgentEditor,
    /// The **person the action changes**, and nobody else — not an admin, not the agent's
    /// owner (ADR-0186 증보 v4 `member.avatar.set`: a profile picture is the one thing a
    /// workspace admin may not put on somebody's face). Judged against a subject the
    /// resolver derives from the run, never from an argument.
    RequestingMember,
    /// ADR-0217: this card's named other human DM participant.
    DmParticipant,
    /// `routes::shared::require_workspace_operator`'s set: a workspace
    /// owner/admin, or a principal carrying the platform operator scope.
    WorkspaceOperator,
    /// ADR-0186 v8 X8-3: a **dynamic** judgement, not a stored role. A live human member
    /// of the card's channel who is not a guest and satisfies the workspace's *current*
    /// add policy; when the card names a face (`subjectMemberId`), also that very person.
    /// No admin or agent-owner proxy. One predicate (`momo_expressions::adder_allows`)
    /// serves the decision route, the push audience and the preview.
    ExpressionAdder,
}

impl RequiredRole {
    pub fn as_wire(self) -> &'static str {
        match self {
            RequiredRole::Admin => "admin",
            RequiredRole::AgentEditor => "agent_editor",
            RequiredRole::RequestingMember => "requesting_member",
            RequiredRole::DmParticipant => "dm_participant",
            RequiredRole::WorkspaceOperator => "workspace_operator",
            RequiredRole::ExpressionAdder => "expression_adder",
        }
    }

    /// The word the summary sentence uses. Kept beside [`Self::as_wire`] so the
    /// wire value and the Korean noun cannot drift into different roles.
    pub fn korean(self) -> &'static str {
        match self {
            RequiredRole::Admin | RequiredRole::WorkspaceOperator => "관리자",
            RequiredRole::AgentEditor => "대상 에이전트의 소유자 또는 관리자",
            RequiredRole::RequestingMember => "요청한 본인",
            RequiredRole::DmParticipant => "카드에 표시된 대화 참여자",
            RequiredRole::ExpressionAdder => "표현을 추가할 수 있는 멤버(얼굴이 있으면 그 본인)",
        }
    }

    /// Every variant, so a test can measure the wire vocabulary against the
    /// OpenAPI enum without a hand-copied list that could omit a new role.
    pub const ALL: [RequiredRole; 6] = [
        RequiredRole::Admin,
        RequiredRole::AgentEditor,
        RequiredRole::RequestingMember,
        RequiredRole::DmParticipant,
        RequiredRole::WorkspaceOperator,
        RequiredRole::ExpressionAdder,
    ];
}

/// Who may **propose** an action (ADR-0201 증보 v2 H6).
///
/// Approval is unchanged by this: every action is decided by a person with the
/// action's [`RequiredRole`]. What this narrows is which proposer may raise the
/// card at all. The three settings actions the team AI gained in v2 were asked for
/// the workspace's own helper, not for every external agent — 0186 V9 결재 3
/// (「에이전트에게는 문구 2개만」) still holds for the Agent Port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proposers {
    /// Only the human DM admission flow; never a model-selected action.
    ServerOnly,
    /// Any agent that may propose: the Agent Port's `oort_action_propose` and the
    /// team AI (when the id is also on [`TEAM_AI_ACTION_IDS`]).
    Any,
    /// Only the workspace's team AI (`workspace_action_propose` in the worker).
    /// The Agent Port refuses the id exactly as it refuses an unknown one.
    TeamAiOnly,
}

/// Which door a proposal came through, judged against [`WorkspaceAction::proposers`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalDoor {
    /// `oort_action_propose` — a hosted (external) agent.
    AgentPort,
    /// `workspace_action_propose` — the workspace's team AI ("oort 도우미").
    TeamAi,
}

impl WorkspaceAction {
    /// May a proposal through `door` name this action?
    pub fn proposable_through(&self, door: ProposalDoor) -> bool {
        match (self.proposers, door) {
            (Proposers::ServerOnly, _) => false,
            (Proposers::Any, _) => true,
            (Proposers::TeamAiOnly, ProposalDoor::TeamAi) => true,
            (Proposers::TeamAiOnly, ProposalDoor::AgentPort) => false,
        }
    }
}

/// How many `workspace_action` approvals one agent may have `pending` at once
/// (ADR-0186 증보 V1-e). A run parks on each proposal, so ordinary use never
/// reaches it; it exists so a misbehaving agent cannot stack cards by re-calling
/// `oort_action_propose` from several runs.
pub const MAX_PENDING_WORKSPACE_ACTIONS: i64 = 3;

/// The actions the workspace's team AI may propose: ADR-0201 D3 v1's four, plus
/// ADR-0201 증보 v2 H6-1's four (`workspace.settings.update` opened to the helper,
/// and the three helper-only settings actions), plus H7's `plugin.install` (opened
/// by #3889). Lives here (not in the proposal crate) because the team AI's tool
/// schema, built in `tools.rs`, publishes it as the `actionId` enum — the model is
/// never told an id the server refuses. A new id here is an ADR amendment, not a
/// code change.
///
/// ADR-0201 증보 v3 B3-T adds `team_ai.roles.set` (#4964): the card that switches the
/// helper's own role bundles. B4 adds `invite.create` and `agent.invite` (#4965, bundle
/// `invite_access`): an invite link and an external agent's pairing code, **always** an admin's
/// approval card, and the one-time value is delivered by the door that raised the card
/// ([`SecretDelivery`], [`raised_by_team_ai`]). Which of these ids one request is actually offered
/// is `team_ai_roles::TeamAiRoles::advertised_action_ids`; this list is the allow-list, not the
/// advertisement.
///
/// Still outside: `hosted.channels.grant` (widens the proposing agent's own access, which the
/// helper does not have, B4-6) and everything declared but not executable (`webhook.create`,
/// `member.role.set`).
pub const TEAM_AI_ACTION_IDS: [&str; 14] = [
    ACTION_AGENT_PROFILE_UPDATE,
    ACTION_AGENT_RENAME,
    ACTION_CHANNEL_CREATE,
    ACTION_CHANNEL_MEMBER_ADD,
    ACTION_WORKSPACE_SETTINGS_UPDATE,
    ACTION_WORKSPACE_UNFURL_UPDATE,
    ACTION_WORKSPACE_MEMORY_UPDATE,
    ACTION_WORKSPACE_WORK_TIER_UPDATE,
    ACTION_PLUGIN_INSTALL,
    ACTION_MEMBER_AVATAR_SET,
    ACTION_MEMBER_DISPLAY_NAME_SET,
    ACTION_INVITE_CREATE,
    ACTION_AGENT_INVITE,
    ACTION_TEAM_AI_ROLES_SET,
];

/// Whether an action's one-time secret may go to the **proposing agent** instead
/// of (only) the approver (ADR-0186 증보 v3 V3-3a, V3-5).
///
/// This is a property of the action, never of the proposal: the agent cannot ask
/// for it, and the decision request's `deliverSecretToAgent` is judged against
/// this value (`OptIn` only) before anything executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretDelivery {
    /// The action has no value the agent may receive.
    None,
    /// The approver chooses at decision time (`deliverSecretToAgent`, default
    /// off). `agent.invite`'s pairing value.
    OptIn,
    /// Always claimable by the proposer; the approver is not shown the value.
    /// `invite.create`'s link (성재 결재 3).
    Always,
}

impl SecretDelivery {
    pub fn as_wire(self) -> &'static str {
        match self {
            SecretDelivery::None => "none",
            SecretDelivery::OptIn => "opt_in",
            SecretDelivery::Always => "always",
        }
    }
}

/// `payload.via_ai.source` of a card the **team AI door** raised (`workspace_action_propose`).
pub const VIA_AI_SOURCE_TEAM_AI: &str = "team_ai";

/// Did the team AI door raise this approval? **The one judgement of the door** (ADR-0201 증보 v3
/// B4-2): it reads the stored approval payload's `via_ai.source`, which only the proposal
/// transaction writes (`momo_workspace_actions::team_ai::propose_in_tx`). Neither the agent's tool
/// call nor the decision request can set it — and a card the Agent Port raised carries no `via_ai`,
/// so it reads as the other door. Every place that depends on the door calls this function: where
/// the one-time value goes ([`secret_route`]), whether `deliverSecretToAgent` may be honoured, the
/// card rows, and the audit provenance.
pub fn raised_by_team_ai(payload: &Value) -> bool {
    payload
        .get("via_ai")
        .and_then(|via| via.get("source"))
        .and_then(Value::as_str)
        == Some(VIA_AI_SOURCE_TEAM_AI)
}

/// Where a decision's one-time value goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretRoute {
    /// The decision response's `secretOnce`, to the approver alone (ADR-0186 D4's original
    /// shape). Also the route of an action that mints no value shown once.
    Approver,
    /// The proposing agent claims it once through the Agent Port (`payload.secretClaim`,
    /// ADR-0186 증보 v3 V3-5). Never the team AI door's.
    ProposerClaim,
    /// The server writes it into the conversation as the team AI's one message (ADR-0201 증보 v3
    /// B4-2). Only an `invite.create` the team AI door raised.
    Conversation,
}

/// The route of this action's one-time value, by **door** (`team_ai_door`, from
/// [`raised_by_team_ai`]) and — for the one action that lets the approver choose — the
/// approver's `deliverSecretToAgent`. One function: the decision tail, the early
/// `deliverSecretToAgent` guard and the executor all read it, so the three cannot disagree.
///
/// | action | Agent Port door | team AI door |
/// |---|---|---|
/// | `invite.create` (`Always`) | `ProposerClaim` | `Conversation` |
/// | `agent.invite` (`OptIn`) | `ProposerClaim` if the approver ticked it, else `Approver` | `Approver` — the flag is not honoured (the route refuses it) |
/// | anything else | `Approver` | `Approver` |
pub fn secret_route(
    action: &WorkspaceAction,
    team_ai_door: bool,
    deliver_to_agent_requested: bool,
) -> SecretRoute {
    match action.secret_delivery {
        SecretDelivery::None => SecretRoute::Approver,
        SecretDelivery::Always if team_ai_door => SecretRoute::Conversation,
        SecretDelivery::Always => SecretRoute::ProposerClaim,
        SecretDelivery::OptIn if team_ai_door => SecretRoute::Approver,
        SecretDelivery::OptIn if deliver_to_agent_requested => SecretRoute::ProposerClaim,
        SecretDelivery::OptIn => SecretRoute::Approver,
    }
}

/// May the approver's `deliverSecretToAgent` be honoured on this card? Only where the action
/// offers the choice **and** the card came through the Agent Port: a helper's `agent.invite` has no
/// box to tick (B4-2), so a decision request that sends the flag is a malformed request.
pub fn offers_opt_in_delivery(action: &WorkspaceAction, team_ai_door: bool) -> bool {
    action.secret_delivery == SecretDelivery::OptIn && !team_ai_door
}

/// The label and the value of the row that says who receives the one-time value, when the **team
/// AI door** raised the card (ADR-0201 증보 v3 B4-2). `None` for an action with no such row.
fn team_ai_delivery_row(action_id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match action_id {
        ACTION_INVITE_CREATE => Some((
            "초대 링크",
            "링크 받는 곳",
            "승인하면 도우미가 이 대화에 링크를 올려요. 대화에 있는 사람은 모두 볼 수 있어요",
        )),
        ACTION_AGENT_INVITE => Some((
            "연결 코드",
            "연결 코드 받는 사람",
            "승인한 분만 한 번 볼 수 있어요",
        )),
        _ => None,
    }
}

/// The request card's rows for a card the team AI door raised: the Agent Port's delivery row
/// (「에이전트가 이 링크를 받아 전달해요」, 「승인할 때 고르세요」) is replaced by the helper's
/// (B4-2) — what the approver reads is what runs. Every other row, and every other action's rows,
/// are returned as they were.
pub fn team_ai_door_rows(action_id: &str, mut rows: Vec<Value>) -> Vec<Value> {
    let Some((agent_port_label, label, text)) = team_ai_delivery_row(action_id) else {
        return rows;
    };
    let replacement = action_row(label, text);
    match rows
        .iter_mut()
        .find(|row| row.get("label").and_then(Value::as_str) == Some(agent_port_label))
    {
        Some(row) => *row = replacement,
        None => rows.push(replacement),
    }
    rows
}

/// The result card's delivery row for an `invite.create` the team AI door raised: the link went
/// to the conversation.
pub const INVITE_CONVERSATION_RESULT_TEXT: &str = "도우미가 이 대화에 링크를 올렸어요";

/// `client_msg_id` of the helper's invite-link message. A fourth key of its own
/// (`invite_link:`), beside `card:` and `result:` — the spine's idempotency guard is
/// `(channel, author, client_msg_id)` and the helper authors all of them in one channel. A
/// retried decision posts the one message, not two.
pub fn invite_link_client_msg_id(approval_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &CARD_CLIENT_MSG_NAMESPACE,
        format!("invite_link:{approval_id}").as_bytes(),
    )
}

/// The provenance a helper card's audit rows carry (ADR-0201 증보 v3 B4-7): **tool names, call
/// counts, token counts and milliseconds** — never text. Copied field by field from the stored
/// `via_ai`, each only if it has the shape the proposal transaction wrote (a number, a short
/// string, an array of short strings), so a payload that was tampered with cannot carry a
/// sentence into the audit trail. `None` when the Agent Port raised the card.
pub fn team_ai_audit_via(payload: &Value) -> Option<Value> {
    if !raised_by_team_ai(payload) {
        return None;
    }
    let via = payload.get("via_ai")?;
    let number = |key: &str| {
        via.get(key)
            .filter(|value| value.is_i64() || value.is_u64())
    };
    let short = |value: &Value| {
        value
            .as_str()
            .is_some_and(|text| text.chars().count() <= 64)
    };
    let mut out = serde_json::Map::new();
    out.insert("source".into(), json!(VIA_AI_SOURCE_TEAM_AI));
    if let Some(model) = via.get("model").filter(|model| short(model)) {
        out.insert("model".into(), model.clone());
    }
    for key in [
        "latency_ms",
        "prompt_tokens",
        "completion_tokens",
        "model_calls",
        "web_searches",
    ] {
        if let Some(value) = number(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(tools) = via.get("tools").and_then(Value::as_array) {
        if tools.iter().all(short) {
            out.insert("tools".into(), json!(tools));
        }
    }
    Some(Value::Object(out))
}

/// `detail` with the helper's provenance added under `via_ai` when the card is a helper card of an
/// action the `invite_access` bundle owns (B4-7). Any other card, from any door, is returned
/// unchanged: this slice adds provenance to the two secret-bearing actions, not to every card.
pub fn with_team_ai_audit_via(action_id: &str, payload: &Value, mut detail: Value) -> Value {
    let owned_by_invites = crate::team_ai_roles::bundle_of_action(action_id)
        .is_some_and(|bundle| bundle.id == crate::team_ai_roles::INVITE_ACCESS);
    if !owned_by_invites {
        return detail;
    }
    if let (Some(via), Some(object)) = (team_ai_audit_via(payload), detail.as_object_mut()) {
        object.insert("via_ai".into(), via);
    }
    detail
}

/// The actions whose approval **mints a value that is shown once** — the invite
/// link (`result.secretOnce.kind` = [`SECRET_ONCE_INVITE_LINK`]) and the pairing
/// code ([`SECRET_ONCE_PAIRING`]).
///
/// ADR-0204 D7 keeps these off the lock screen: approving one mints a value that is
/// handed back exactly once — in the decision response to the approver's client, or
/// to the proposer's claim — and a banner button has nowhere to receive it. The
/// person would approve from a banner and the value would be gone. The list is written out
/// instead of derived from [`SecretDelivery`] because delivery to the *proposing
/// agent* and minting a secret for the *approver* are different facts that happen
/// to coincide today. Two tests hold it: every action that delivers a secret is
/// here, and every registered action has its lock-screen decision **written down**
/// (`every_registered_action_has_a_recorded_lock_screen_decision`) — an action
/// that mints a value for the approver without delivering it to the agent has no
/// `SecretDelivery` to trip the first, and trips the second.
pub const ONE_TIME_SECRET_ACTION_IDS: [&str; 2] = [ACTION_INVITE_CREATE, ACTION_AGENT_INVITE];

/// Tool calls whose approval is **opened in the app** because the lock screen cannot
/// show what the approver is being asked to look at (planner decision 2026-10-17).
///
/// `work.session.login_handoff` stops a run in front of a login screen and asks a
/// person to log in on the session's own screen (LIVE-4): what they approve is
/// *which* session and *why*, on a card that carries the deep link to it. A banner
/// 승인 would consent to a handoff nobody had looked at. Matched on the tool name
/// as [`crate::tools::normalize`] reads it — the same reading the card's own props
/// use ([`crate::approval::login_handoff_session_id`]).
pub const OPEN_IN_APP_TOOL_NAMES: [&str; 1] = [crate::tools::WORK_SESSION_LOGIN_HANDOFF];

/// Does this `agent.profile.update` card change the agent's **avatar**? True when its
/// arguments carry an `avatar` key at all — a preset, an attachment, an image the
/// server staged for the approver to preview, or `null` (remove it).
///
/// Planner decision 2026-10-17: a picture cannot be judged from a banner. The
/// approver looks at the staged image on the card (`approvals.avatar_preview`) and
/// then decides; a lock-screen 승인 would approve pixels nobody saw. Only the key's
/// *presence* is read — never its value — so the judgment's payload projection can
/// carry the answer as a bare marker.
pub fn changes_avatar(payload: &Value) -> bool {
    payload
        .get("action")
        .and_then(|action| action.get("args"))
        .and_then(Value::as_object)
        .is_some_and(|args| args.contains_key("avatar"))
}

/// Like the avatar marker, only key presence is needed to open a name change.
fn changes_display_name(payload: &Value) -> bool {
    payload
        .get("action")
        .and_then(|action| action.get("args"))
        .and_then(Value::as_object)
        .is_some_and(|args| args.contains_key("displayName"))
}

/// How an approval is decided: where it is shown (`Inline`) or in the app (`Open`).
///
/// ADR-0204 증보 6 D6-2: the push category, the `push_action` token's refusal, the card's
/// `props.decision_mode` and every client's decision button read **one** answer, from
/// [`decision_mode`]. A client never works it out again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionMode {
    /// Decided where it is shown — the banner's 승인·거부 behind Face ID, the card's buttons.
    Inline,
    /// Decided in the app, on the card: no lock-screen button, no inbox-row button, no chip
    /// button (the push category is `momo.approval.open`).
    Open,
}

impl DecisionMode {
    /// The wire word of `props.decision_mode`.
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionMode::Inline => "inline",
            DecisionMode::Open => "open",
        }
    }

    pub fn is_open(self) -> bool {
        self == DecisionMode::Open
    }
}

/// Why an approval is decided the way it is — the criteria of ADR-0204 증보 6 D6-1/D6-2, one
/// word each. It is the column the recorded tables carry
/// (`every_registered_action_has_a_recorded_lock_screen_decision`,
/// `every_catalog_tool_has_a_recorded_lock_screen_decision` and the push classification
/// table), so that a new action cannot be registered without saying which side it is on, and
/// why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionReason {
    /// Approving it mints a value shown once (an invite link, a pairing code).
    OneTimeValue,
    /// It widens who may read or write: an agent asking for more channels.
    Permission,
    /// The server cannot say it can be undone: a tool outside the catalog, whose effect it does
    /// not know. (No registered action is irreversible: each has an opposite action or a
    /// settings screen.)
    Irreversible,
    /// A person cannot judge it from a banner: a picture, a message quoted from thousands of
    /// characters, a name next to its old one, a host to pick, a login to do.
    NeedsTheApp,
    /// Nobody asked: an agent raised it on its own (「먼저 제안」).
    Unasked,
    /// A shape this build does not know — it opens (ADR-0204 「무엇인지 모르는 알림에는 버튼이
    /// 없다」).
    UnknownShape,
    /// None of the above: the banner can show what is being approved.
    None,
}

impl DecisionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DecisionReason::OneTimeValue => "one_time_value",
            DecisionReason::Permission => "permission",
            DecisionReason::Irreversible => "irreversible",
            DecisionReason::NeedsTheApp => "needs_the_app",
            DecisionReason::Unasked => "unasked",
            DecisionReason::UnknownShape => "unknown_shape",
            DecisionReason::None => "none",
        }
    }
}

/// How this approval is decided — **the one function** (ADR-0204 증보 6 D6-2). The push
/// category (`momo_push::category_for`), the `push_action` token's refusal (403
/// `opens_in_app`, #3977), the approval card's `props.decision_mode` and every client's
/// decision button read this answer; nothing else decides.
///
/// `Open` is for what a person has to look at in the app, and for what a banner must never
/// approve on its own (ADR-0204 D6-1: 「되돌릴 수 없음 · 권한 · 1회 값 · 먼저 제안」):
///
/// 1. an action that mints a value shown once ([`ONE_TIME_SECRET_ACTION_IDS`]);
/// 2. an approval whose card asks the approver to **choose a host**
///    ([`crate::approval::offers_host_choice`] — every `work.spawn` card does).
///    A banner 승인 would take the card's default machine without the person
///    having looked at the picker;
/// 3. a tool call the lock screen cannot show ([`OPEN_IN_APP_TOOL_NAMES`] — the login
///    handoff, planner decision 2026-10-17);
/// 4. an `agent.profile.update` that changes the avatar or name, every
///    `member.avatar.set`, `member.display_name.set` and `agent.rename`: the person
///    sees the picture or the before/after name in the app (#4810);
/// 5. every `message.pin` and `message.unpin` (ADR-0186 증보 v5 U-e): the card names a
///    message by its first 120 characters, and a pin endorses all of it;
/// 6. **a `hosted.channels.grant` an agent asked for** (D6-2: 권한 — the agent may read and
///    write more than before). The card the server raised in place, because a person called
///    the agent in that very channel (`origin = server_in_place`), is the exception: the
///    person has just asked for that, so it is still decided from the banner;
/// 7. **a tool call outside the catalog** — an operator's own `agent.tool_schema` function
///    (`tools::momo_tool_name`). momo does not own its name and cannot say whether what it
///    does can be undone, and 「모르면 연다」 (D6-2; this turns the earlier choice, 2026-10-17,
///    around);
/// 8. a card an agent raised unasked ([`crate::initiative::is_agent_initiated`]);
/// 9. ADR-0188 D5's work-host permission requests. They are `work_permission_request`
///    rows with no `approval` row and no `approval_request` message today, so
///    there is nothing here to classify; the producer that gives them one adds its
///    arm in this function.
///
/// Everything else this build **knows** — a tool of the catalog, a workspace action it
/// carries that mints nothing shown once, widens nothing and shows no picture — is decidable
/// from the lock screen behind Face ID (ADR-0204 D7: 「기본은 inline이고, open 목록은 서버 코드
/// 한 곳에 둔다」). `channel.member.add`, `plugin.install` and `workspace.work_tier.update` are
/// **not** 「권한」 (D6-9 결재 3), and `member.role.set` is not registered yet — it reads as an
/// unknown shape and opens, and it stays open when it is registered.
///
/// **What it does not understand it opens.** A workspace action this build's registry does not
/// carry (the notifier is older than the server that wrote the card — a rolling deploy — or the
/// action was retired), a workspace action whose payload names none, a tool call whose payload
/// names no tool (a card with nothing to say what it is), and an `action_type` that is not one
/// of the three producers write today all answer `Open`: the cost of a wrong guess is a card
/// opened in the app, the cost of the other wrong guess is an approval nobody could look at.
///
/// ## What it may read
///
/// Only `action.id`, whether `action.args` is an object with an `avatar` or `displayName` key,
/// `tool_call.name`, `execution` and `origin` — the paths the push judgment's payload
/// projection carries (`momo_push` `judgment.rs`). Never an argument's value. The projection
/// and this function must say the same thing about the same card: the push judges the
/// projection, the decision route (#3977) the whole payload.
/// `push_conformance_pg::an_approval_that_must_be_opened_…` asserts exactly that for every card
/// of its table, and `momo-push/tests/judgment_projection.rs` fails if the statement reads a
/// path of the payload nobody listed.
pub fn decision_mode(action_type: &str, payload: &Value) -> DecisionMode {
    judge(action_type, payload).0
}

/// The reason behind [`decision_mode`]'s answer — the column of the recorded tables. Same
/// judgment, so the two can never disagree.
pub fn decision_reason(action_type: &str, payload: &Value) -> DecisionReason {
    judge(action_type, payload).1
}

/// Write `props.decision_mode` on an approval card's props — `mode` is
/// [`decision_mode`] answered for the card's own approval payload. Call it on the props
/// **before** the card is inserted: the insert's own realtime frame carries the props, and an
/// update after it would reach no client until a refresh.
pub fn stamp_decision_mode(props: &mut Value, mode: DecisionMode) {
    if let Some(object) = props.as_object_mut() {
        object.insert(DECISION_MODE_PROPS_KEY.into(), json!(mode.as_str()));
    }
}

/// The card props key [`stamp_decision_mode`] writes.
pub const DECISION_MODE_PROPS_KEY: &str = "decision_mode";

/// Must this approval be opened in the app to be decided — i.e. may its push **not** carry the
/// lock-screen 승인·거부 buttons? (ADR-0204 D7: the category `momo.approval.open` instead of
/// `momo.approval`.) Exactly `decision_mode(..) == Open`; kept as a one-line alias for the
/// readers that ask a yes/no question.
pub fn opens_in_app(action_type: &str, payload: &Value) -> bool {
    decision_mode(action_type, payload).is_open()
}

fn judge(action_type: &str, payload: &Value) -> (DecisionMode, DecisionReason) {
    use DecisionMode::{Inline, Open};
    use DecisionReason as Why;
    if crate::approval::offers_host_choice(payload) {
        return (Open, Why::NeedsTheApp);
    }
    match action_type {
        crate::tools::ACTION_TYPE_TOOL_CALL => {
            let Some(name) = payload
                .get("tool_call")
                .and_then(|call| call.get("name"))
                .and_then(Value::as_str)
            else {
                return (Open, Why::UnknownShape);
            };
            let normalized = crate::tools::normalize(name);
            if OPEN_IN_APP_TOOL_NAMES
                .iter()
                .any(|open| crate::tools::normalize(open) == normalized)
            {
                (Open, Why::NeedsTheApp)
            } else if !crate::tools::is_executable(name) {
                // An operator's own tool: whether it can be undone is not something this
                // server knows (ADR-0204 증보 6 D6-2 · D6-9 결재 1).
                (Open, Why::Irreversible)
            } else {
                (Inline, Why::None)
            }
        }
        ACTION_TYPE_WORKSPACE_ACTION => {
            let Some(id) = payload
                .get("action")
                .and_then(|action| action.get("id"))
                .and_then(Value::as_str)
            else {
                return (Open, Why::UnknownShape);
            };
            if action_by_id(id).is_none() {
                return (Open, Why::UnknownShape);
            }
            // A card nobody asked for is never decided from a banner: the person did not ask,
            // so a 승인 button would consent to something they never looked at (ADR-0186 증보
            // v5 U-c). Reads `origin`, a path the push projection carries.
            if crate::initiative::is_agent_initiated(payload) {
                return (Open, Why::Unasked);
            }
            if ONE_TIME_SECRET_ACTION_IDS.contains(&id) {
                return (Open, Why::OneTimeValue);
            }
            // The agent reads and writes more than before. Only the card the server itself
            // raised in place — a person called the agent in that very channel — is the
            // exception (ADR-0204 증보 6 D6-2).
            if id == ACTION_HOSTED_CHANNELS_GRANT
                && !crate::in_place_grant::is_in_place_grant(payload)
            {
                return (Open, Why::Permission);
            }
            let in_app = (id == ACTION_AGENT_PROFILE_UPDATE
                && (changes_avatar(payload) || changes_display_name(payload)))
                // A name change is decided with the before/after name visible (#4810).
                || id == ACTION_MEMBER_DISPLAY_NAME_SET
                || id == ACTION_AGENT_RENAME
                // A picture cannot be judged from a banner — and this card has no
                // other kind of proposal, so it is always opened (ADR-0186 증보 v4).
                || id == ACTION_MEMBER_AVATAR_SET
                || id == ACTION_DM_AGENT_ADMIT
                // A message cannot be judged from a banner either: the card shows the
                // first 120 characters of something that can be thousands (ADR-0186
                // 증보 v5 U-e, review M4), so the approver reads it in the app.
                || id == ACTION_MESSAGE_PIN
                || id == ACTION_MESSAGE_UNPIN
                // The picture is the whole point of the card, and the lock screen shows
                // none: the push says 「앱에서 확인」 and offers no 승인 button
                // (ADR-0186 증보 v8 X8-3).
                || id == ACTION_EXPRESSION_CREATE
                // The card carries the 「공급자로 가는 내용」 line for `files` and `memory`;
                // approving is the consent to it, so it is read in the app (ADR-0201 증보
                // v3 B3-T). The id decides — an argument's value is never read here.
                || id == ACTION_TEAM_AI_ROLES_SET;
            if in_app {
                (Open, Why::NeedsTheApp)
            } else {
                (Inline, Why::None)
            }
        }
        _ => (Open, Why::UnknownShape),
    }
}

/// How long after the approval the proposer may claim the value (V3-4 (4)).
/// After this the value never leaves the server; the approver can still mint a
/// fresh one over the existing regenerate routes.
pub const SECRET_CLAIM_WINDOW_MS: i64 = 30 * 60 * 1000;

/// The approval payload key that records a granted claim.
pub const SECRET_CLAIM_PAYLOAD_KEY: &str = "secretClaim";

/// `kind` of a claimed value (V3-4): what the value is, not how it looks.
pub const SECRET_CLAIM_KIND_PAIRING: &str = "pairing";
pub const SECRET_CLAIM_KIND_INVITE: &str = "invite";

/// `audit_log.action` of a claim: who, which approval, which kind — never the value.
pub const AUDIT_SECRET_CLAIMED: &str = "agent.secret.claimed";
pub const AUDIT_SECRET_CLAIMED_SCHEMA: &str = "momo.agent.secret.claimed.v1";

/// `payload.secretClaim` for a claim granted at `decided_at_ms`:
/// `{allowed:true, deadlineMs}`. `claimedAtMs` is added by the claim itself,
/// under the approval row lock, and is what makes the claim single-use.
pub fn secret_claim_grant(decided_at_ms: i64) -> Value {
    json!({"allowed": true, "deadlineMs": decided_at_ms.saturating_add(SECRET_CLAIM_WINDOW_MS)})
}

/// What a claim attempt finds in `payload.secretClaim`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretClaimState {
    /// No grant: the approval never allowed the proposer to claim.
    NotGranted,
    Open,
    AlreadyClaimed,
    Expired,
}

/// Judge a claim against the stored marker. Pure so the single-use and the
/// deadline are measurable without a database; the claim route calls it under
/// the approval's row lock.
pub fn secret_claim_state(approval_payload: &Value, now_ms: i64) -> SecretClaimState {
    let Some(claim) = approval_payload.get(SECRET_CLAIM_PAYLOAD_KEY) else {
        return SecretClaimState::NotGranted;
    };
    if claim.get("allowed").and_then(Value::as_bool) != Some(true) {
        return SecretClaimState::NotGranted;
    }
    if claim.get("claimedAtMs").is_some_and(|v| !v.is_null()) {
        return SecretClaimState::AlreadyClaimed;
    }
    match claim.get("deadlineMs").and_then(Value::as_i64) {
        Some(deadline) if now_ms <= deadline => SecretClaimState::Open,
        _ => SecretClaimState::Expired,
    }
}

/// One action this server can be asked to take.
#[derive(Debug, Clone, Copy)]
pub struct WorkspaceAction {
    pub id: &'static str,
    /// The card's heading and the catalog row's name.
    pub title: &'static str,
    /// One line, for the catalog row. The approval card's own summary is
    /// [`proposal_summary`], which adds what approving *does*.
    pub summary: &'static str,
    pub risk: Risk,
    pub required_role: RequiredRole,
    /// Whether the proposing agent may be handed this action's one-time value
    /// (ADR-0186 증보 v3 V3-3a/V3-4). Everything is [`SecretDelivery::None`]
    /// until the slice that implements the claim flips its own action.
    pub secret_delivery: SecretDelivery,
    /// Which proposers may raise this card (ADR-0201 증보 v2 H6).
    pub proposers: Proposers,
    /// May an agent raise this card **unasked**, through `oort_action_initiate`
    /// (ADR-0186 증보 v5 U-b-2, #4704)? The one definition: the tool's `actionId` enum, the
    /// OpenAPI `InitiativeActionId` and the catalog's `initiative` flag are all read from here
    /// and measured against each other (`routes::actions`' drift test). Four actions are
    /// `true`; never one that mints a value shown once, widens what an agent reads, or
    /// changes who or what an agent is (`every_initiative_action_is_one_a_person_may_look_at`).
    pub initiative: bool,
    /// What approving this executes, as a verb phrase. Only used to build
    /// [`proposal_summary`]; it lives here so a new action cannot be added
    /// without writing the sentence a person reads before consenting.
    effect: &'static str,
    /// The approval as **one question** a person answers on a lock screen (ADR-0204 증보 6
    /// D6-3): the card's `body` and the push's text. No value and no particle after a value —
    /// a value is quoted after it (`question · 「value」`, see
    /// [`crate::approval_sentence`]).
    pub question: &'static str,
    /// What was done, past tense, for the decision's `receipt.line` (D6-4: 「✓ 소개를
    /// 바꿨어요」 is `✓ ` + this). Value-free, like [`Self::question`].
    pub done: &'static str,
    args_schema: fn() -> Value,
}

/// Identity is the **id**, like `momo_mcp::ToolDescriptor`: the struct holds a
/// function pointer whose address is not a meaningful value to compare.
impl PartialEq for WorkspaceAction {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for WorkspaceAction {}

impl WorkspaceAction {
    /// The published JSON Schema for this action's `args` object — the same
    /// object `GET …/actions` advertises, `oort_action_propose` embeds, and the
    /// domain validators then re-prove.
    pub fn args_schema(&self) -> Value {
        (self.args_schema)()
    }

    /// What approving this executes, as a verb phrase — for a card that builds its own summary
    /// sentence ([`crate::initiative::initiative_summary`]).
    pub fn effect_phrase(&self) -> &'static str {
        self.effect
    }
}

/// The roles a **proposal** may ask for.
///
/// `momo_settings::normalized_invite_role` also accepts `guest`; a proposal may
/// not. Narrowing here rather than there is deliberate — the REST surface serves
/// a human admin who can see the whole workspace, and this one serves a card
/// somebody reads in a channel.
pub const INVITE_PROPOSABLE_ROLES: [&str; 2] = ["member", "admin"];
/// The proposal ceiling on `maxUses`. The REST validator allows 10,000.
pub const INVITE_MAX_USES_CEILING: i64 = 100;
/// The proposal ceiling on `expiresInDays`.
pub const INVITE_EXPIRES_IN_DAYS_CEILING: i64 = 30;

/// `invite.create` arguments (ADR-0186 부록 E).
///
/// **Narrower than the REST surface on purpose** — see the three constants
/// above. The published numbers are those constants rather than literals,
/// because the server re-proves them with `momo_settings`' validators and a
/// schema that advertised a different ceiling than the one enforced would be the
/// exact divergence this registry exists to remove.
fn invite_create_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "role": {"type": "string", "enum": INVITE_PROPOSABLE_ROLES},
            "maxUses": {"type": "integer", "minimum": 1, "maximum": INVITE_MAX_USES_CEILING},
            "expiresInDays": {
                "type": "integer",
                "minimum": 1,
                "maximum": INVITE_EXPIRES_IN_DAYS_CEILING
            }
        }
    })
}

/// The channel kinds a proposal may ask for. `dm` is never creatable here.
pub const CHANNEL_CREATE_KINDS: [&str; 2] = ["public", "private"];
/// What `kind` means when a proposal names none: **private**. An agent that wants
/// a public channel has to say so, and the card shows it.
pub const CHANNEL_CREATE_DEFAULT_KIND: &str = "private";
/// `name` bound in UTF-8 bytes (the domain's 80 is characters, but the accepted
/// alphabet is ASCII, so the two coincide for every legal name).
pub const CHANNEL_NAME_MAX_BYTES: u64 = 80;
/// `topic` bound in UTF-8 bytes: the domain's 280 characters at the 4-byte
/// worst case. The domain normaliser still enforces the 280 characters.
pub const CHANNEL_TOPIC_MAX_BYTES: u64 = 1_120;
/// A proposal names at most this many members to add alongside.
pub const ACTION_MEMBER_HANDLES_MAX: u64 = 10;
/// A handle is 2..=32 characters; one leading `@` is tolerated, hence 33.
pub const MEMBER_HANDLE_MAX_BYTES: u64 = 33;

/// `channel.create` arguments (증보 V2).
fn channel_create_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["name"],
        "properties": {
            "name": {"type": "string", "minLength": 1, "maxLength": CHANNEL_NAME_MAX_BYTES},
            "kind": {"type": "string", "enum": CHANNEL_CREATE_KINDS},
            "topic": {"type": "string", "maxLength": CHANNEL_TOPIC_MAX_BYTES},
            "addProposer": {"type": "boolean"},
            "memberHandles": {
                "type": "array",
                "maxItems": ACTION_MEMBER_HANDLES_MAX,
                "items": {"type": "string", "minLength": 1, "maxLength": MEMBER_HANDLE_MAX_BYTES}
            }
        }
    })
}

/// `channel.member.add` arguments (증보 V2): the channel by **name**, members by
/// handle, no role (always `member`).
fn channel_member_add_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["channel", "memberHandles"],
        "properties": {
            "channel": {"type": "string", "minLength": 1, "maxLength": CHANNEL_REF_MAX_BYTES},
            "memberHandles": {
                "type": "array",
                "minItems": 1,
                "maxItems": ACTION_MEMBER_HANDLES_MAX,
                "items": {"type": "string", "minLength": 1, "maxLength": MEMBER_HANDLE_MAX_BYTES}
            }
        }
    })
}

/// The raw `displayName` an agent may send, in UTF-8 bytes. The real bound is
/// 32 characters **after** normalisation (`momo_messaging::name_guard`); this is
/// the first fence and leaves room for a compatibility form that normalises
/// shorter.
pub const AGENT_RENAME_NAME_MAX_BYTES: u64 = 256;

/// `agent.rename` arguments (증보 V2): the new name, and optionally which of the
/// proposer's managed agents (by handle) — absent means the proposer itself.
/// `platform` of `agent.invite`: a display/preset key and **never** a ground for
/// authority (ADR-0162 D6). The pair is (wire key, label the card shows).
pub const AGENT_INVITE_PLATFORMS: [(&str, &str); 4] = [
    ("grok_bot", "Grok Bot"),
    ("dots", "dots"),
    ("muse", "Muse"),
    ("other", "다른 에이전트"),
];

/// The label the card shows for a platform key, `None` for an unknown key.
pub fn agent_invite_platform_label(key: &str) -> Option<&'static str> {
    AGENT_INVITE_PLATFORMS
        .iter()
        .find(|(wire, _)| *wire == key)
        .map(|(_, label)| *label)
}

/// `agent.invite` arguments (V3-3): a name, a handle and the platform preset. No
/// id, scope or channel — those are decided by a human at the confirm step.
fn agent_invite_args_schema() -> Value {
    let platforms: Vec<&str> = AGENT_INVITE_PLATFORMS.iter().map(|(key, _)| *key).collect();
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["platform", "displayName", "handle"],
        "properties": {
            "platform": {"type": "string", "enum": platforms},
            "displayName": {"type": "string", "minLength": 1, "maxLength": AGENT_RENAME_NAME_MAX_BYTES},
            "handle": {"type": "string", "minLength": 1, "maxLength": MEMBER_HANDLE_MAX_BYTES}
        }
    })
}

fn agent_rename_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["displayName"],
        "properties": {
            "displayName": {"type": "string", "minLength": 1, "maxLength": AGENT_RENAME_NAME_MAX_BYTES},
            "targetHandle": {"type": "string", "minLength": 1, "maxLength": MEMBER_HANDLE_MAX_BYTES}
        }
    })
}

/// `tagline` ceiling as the tool schema counts it: 140 characters at the UTF-8
/// worst case. The domain validator enforces the 140 characters.
pub const PROFILE_TAGLINE_MAX_BYTES: u64 = 560;
/// `statusText`: 80 characters at the UTF-8 worst case.
pub const PROFILE_STATUS_TEXT_MAX_BYTES: u64 = 320;
/// `statusEmoji`: bytes, generously (four emoji with variation selectors).
pub const PROFILE_STATUS_EMOJI_MAX_BYTES: u64 = 64;
/// `roleLabel`: 24 characters at the UTF-8 worst case.
pub const PROFILE_ROLE_LABEL_MAX_BYTES: u64 = 96;
/// A status an agent sets ends on its own: hours, default and ceiling (V3-2).
pub const PROFILE_STATUS_HOURS_DEFAULT: i64 = 24;
pub const PROFILE_STATUS_HOURS_MAX: i64 = 168;
/// The keys the card patch may carry, besides `targetHandle`.
pub const PROFILE_UPDATE_FIELD_KEYS: [&str; 7] = [
    "displayName",
    "tagline",
    "statusText",
    "statusEmoji",
    "statusExpiresInHours",
    "roleLabel",
    "avatar",
];

/// The longest `avatar.dataBase64` the tool schema admits, in characters:
/// base64 of [`momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_GENERATED`] (44 000
/// bytes) is 58 668 characters, and the whole call has to fit the Agent Port's
/// 64 KiB body.
pub const AVATAR_GENERATED_B64_MAX_CHARS: u64 = 58_700;
/// An attachment id is a UUID in its hyphenated text form.
pub const AVATAR_ID_TEXT_MAX_CHARS: u64 = 36;
/// An avatar preset id, in characters (the presets are short ids).
pub const AVATAR_PRESET_ID_MAX_CHARS: u64 = 24;

/// `agent.profile.update` arguments (증보 v3 V3-2). Every property is optional
/// and at least one is required; **`null` clears** `tagline`, `roleLabel` and the
/// status (so a proposer must omit what it is not changing, as for
/// `workspace.settings.update`). `displayName` is never cleared.
fn agent_profile_update_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "minProperties": 1,
        "properties": {
            "displayName": {"type": "string", "minLength": 1, "maxLength": AGENT_RENAME_NAME_MAX_BYTES},
            "tagline": {"type": "string", "maxLength": PROFILE_TAGLINE_MAX_BYTES},
            "statusText": {"type": "string", "maxLength": PROFILE_STATUS_TEXT_MAX_BYTES},
            "statusEmoji": {"type": "string", "maxLength": PROFILE_STATUS_EMOJI_MAX_BYTES},
            "statusExpiresInHours": {"type": "integer", "minimum": 1, "maximum": PROFILE_STATUS_HOURS_MAX},
            "roleLabel": {"type": "string", "maxLength": PROFILE_ROLE_LABEL_MAX_BYTES},
            "avatar": {
                "type": "object",
                "description": "One of {source:'preset',presetId}, {source:'attachment',attachmentId} or {source:'generated',dataBase64}; null removes the avatar."
            },
            "targetHandle": {"type": "string", "minLength": 1, "maxLength": MEMBER_HANDLE_MAX_BYTES}
        }
    })
}

/// Exactly one image source: the requester's attachment in this conversation,
/// or generated/retrieved base64 (v7). Closed keys; the normalizer also enforces
/// mutual exclusion. The target always comes from the run.
fn member_avatar_set_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "minProperties": 1,
        "properties": {
            "attachmentId": {
                "type": "string",
                "minLength": 1,
                "maxLength": AVATAR_ID_TEXT_MAX_CHARS,
                "description": "The id (imageAttachments[].id from oort_conversation_read) of an image the person who called you attached in THIS conversation."
            },
            "avatar": {
                "type": "object",
                "additionalProperties": false,
                "required": ["source", "dataBase64"],
                "properties": {
                    "source": {"type": "string", "enum": ["generated"]},
                    "dataBase64": {"type": "string", "minLength": 1, "maxLength": AVATAR_GENERATED_B64_MAX_CHARS}
                },
                "description": "An image you generated or retrieved, PNG/JPEG/WebP, strict base64, at most 44000 input bytes. No URL; retrieve and downscale it first."
            }
        }
    })
}

/// One expression candidate's picture, as the proposal names it (ADR-0218 부록 B
/// `AgentImage`): the requester's attachment in this conversation, one public HTTPS link,
/// bytes the agent made itself, or one candidate of a motion assembly the server kept for it
/// (G3.6). Closed keys; the domain normaliser enforces the rest.
pub const EXPRESSION_CANDIDATES_MAX: u64 = 4;
/// base64 of one generated candidate's at most 1 MiB (ADR-0218 D3).
pub const EXPRESSION_GENERATED_B64_MAX_CHARS: u64 = 1_398_104;
pub const EXPRESSION_PROMPT_MAX_BYTES: u64 = 8_000;
pub const EXPRESSION_URL_MAX_BYTES: u64 = 2_048;

fn expression_create_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["candidates"],
        "properties": {
            "candidates": {
                "type": "array",
                "minItems": 1,
                "maxItems": EXPRESSION_CANDIDATES_MAX,
                "description": "1-4 candidates for ONE expression; every candidate names the same subjectMemberId. A person picks one after seeing the stored picture.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["name", "displayName", "tags", "image"],
                    "properties": {
                        "name": {"type": "string", "minLength": 2, "maxLength": 30, "description": "[a-z0-9_-], 2-30 characters, permanent once saved."},
                        "displayName": {"type": "string", "minLength": 1, "maxLength": 160},
                        "tags": {"type": "array", "maxItems": 8, "items": {"type": "string", "minLength": 1, "maxLength": 64}},
                        "subjectMemberId": {"type": ["string", "null"], "maxLength": 36, "description": "REQUIRED to be present: null = nobody's face is in the picture (your declaration); otherwise the one workspace member whose face it is, and only that member can approve."},
                        "image": {
                            "type": "object",
                            "oneOf": [
                                {"type": "object", "additionalProperties": false, "required": ["source", "attachmentId"],
                                 "properties": {"source": {"type": "string", "enum": ["attachment"]},
                                                "attachmentId": {"type": "string", "minLength": 36, "maxLength": 36}}},
                                {"type": "object", "additionalProperties": false, "required": ["source", "url"],
                                 "properties": {"source": {"type": "string", "enum": ["url"]},
                                                "url": {"type": "string", "minLength": 8, "maxLength": EXPRESSION_URL_MAX_BYTES}}},
                                {"type": "object", "additionalProperties": false, "required": ["source", "mime", "dataBase64", "prompt"],
                                 "properties": {"source": {"type": "string", "enum": ["generated"]},
                                                "mime": {"type": "string", "enum": ["image/png", "image/jpeg", "image/gif", "image/webp"]},
                                                "dataBase64": {"type": "string", "minLength": 4, "maxLength": EXPRESSION_GENERATED_B64_MAX_CHARS},
                                                "prompt": {"type": "string", "minLength": 1, "maxLength": EXPRESSION_PROMPT_MAX_BYTES}}},
                                {"type": "object", "additionalProperties": false, "required": ["source", "assemblyId", "index"],
                                 "description": "One candidate of what oort_expression_assemble kept for you (ADR-0218 G3.6). The picture, prompt and original photo are the ones stored there; yours or another person's assembly, an expired or an unknown one is refused alike.",
                                 "properties": {"source": {"type": "string", "enum": ["assembled"]},
                                                "assemblyId": {"type": "string", "minLength": 36, "maxLength": 36},
                                                "index": {"type": "integer", "minimum": 0, "maximum": 3}}}
                            ]
                        }
                    }
                }
            }
        }
    })
}

/// The outcome line of `expression.create` (ADR-0218 부록 C).
pub fn expression_create_result_body() -> String {
    "팀 보관함에 저장했어요".to_string()
}

/// `ref.type` of an executed `expression.create`: the expression that was saved.
pub const REF_TYPE_EXPRESSION: &str = "expression";

/// `audit_log.action` / schema of an approved `expression.create`: ids, origin kind and
/// domain, a sha256 **prefix**, the decider and the approval — never bytes, base64, the
/// generation prompt or an original link.
pub const AUDIT_EXPRESSION_CREATED: &str = "expression.created";
/// A candidate that was staged for the card: origin kind/domain, the closed reason code if
/// the receive failed, a sha256 prefix if it is a picture. Written for every candidate so
/// the reason survives the TTL sweep that clears the draft's own `code` (ADR-0218 D6).
pub const AUDIT_EXPRESSION_STAGED: &str = "expression.staged";
pub const AUDIT_EXPRESSION_STAGED_SCHEMA: &str = "momo.expression.staged.v1";

fn member_display_name_set_args_schema() -> Value {
    json!({
        "type": "object", "additionalProperties": false, "required": ["displayName"],
        "properties": {"displayName": {"type": "string", "minLength": 1, "maxLength": 400}}
    })
}

/// The card row naming whose picture changes. Both halves are the server's (the person
/// the run was raised by, read from the member row).
pub fn member_avatar_set_rows(display_name: &str, handle: &str, had_avatar: bool) -> Vec<Value> {
    vec![
        action_row("대상", member_card_label(display_name, handle, false)),
        action_row(
            "프로필 사진",
            if had_avatar {
                "현재 사진 → 카드에 보이는 새 이미지"
            } else {
                "없음 → 카드에 보이는 새 이미지"
            },
        ),
        action_row("사진 출처", "내가 이 대화에 보낸 첨부"),
    ]
}

/// The outcome line of `member.avatar.set`.
pub fn member_avatar_set_result_body() -> String {
    "프로필 사진을 바꿨어요".to_string()
}

/// `audit_log.action` / schema of an approved `member.avatar.set`: ids, origin, measured
/// size and a sha256 **prefix** — never the bytes (same discipline as
/// [`AUDIT_AGENT_AVATAR_UPDATED`]).
pub const AUDIT_MEMBER_AVATAR_SET: &str = "member.avatar.set";
pub const AUDIT_MEMBER_AVATAR_SET_SCHEMA: &str = "momo.member.avatar.set.v1";
/// A `member.avatar.set` proposal that was **staged** for the person's review.
pub const AUDIT_MEMBER_AVATAR_STAGED: &str = "member.avatar.staged";
pub const AUDIT_MEMBER_AVATAR_STAGED_SCHEMA: &str = "momo.member.avatar.staged.v1";
/// A `member.avatar.set` proposal the server refused before staging anything. `reason` is
/// a code (`unsupported_type`, `too_large`, `animated`, …), never input bytes; the
/// agent itself only ever sees the one opaque `InvalidArguments`.
pub const AUDIT_MEMBER_AVATAR_REFUSED: &str = "member.avatar.refused";
pub const AUDIT_MEMBER_AVATAR_REFUSED_SCHEMA: &str = "momo.member.avatar.refused.v1";

/// How many `member.avatar.set` proposals (staged or refused) one person can be the
/// subject of per hour (ADR-0186 증보 v4 V4-10 5). Past it the proposal is refused
/// before any image is fetched or decoded, with the audit reason `rate_limited`
/// (which does not itself count, so the window drains).
pub const MEMBER_AVATAR_PROPOSALS_PER_HOUR: i64 = 10;
/// The audit reason code for a proposal refused by that ceiling.
pub const MEMBER_AVATAR_RATE_LIMITED_REASON: &str = "rate_limited";

/// The proposal ceiling on `welcomePrompt`, in characters. The REST surface allows
/// 2000: this text is read by a *different agent* (the welcome agent), so a
/// proposal — an agent writing another agent's instructions — gets a quarter.
pub const WELCOME_PROMPT_PROPOSAL_MAX_CHARS: usize = 500;
/// The same, as the bytes the tool schema counts (500 characters at the UTF-8
/// worst case). The domain normaliser enforces the 500 characters.
pub const WELCOME_PROMPT_PROPOSAL_MAX_BYTES: u64 = 2_000;
/// Human roles that may carry a display label (`momo_settings::ROLE_LABEL_KEYS`).
pub const ROLE_LABEL_PROPOSAL_KEYS: [&str; 4] = ["owner", "admin", "member", "guest"];
/// One role label, in UTF-8 bytes (`momo_settings::MAX_ROLE_LABEL_BYTES`).
pub const ROLE_LABEL_MAX_BYTES: u64 = 48;

/// `workspace.settings.update` arguments (증보 V2/V7): exactly the two keys, and
/// at least one. `null` clears a key back to its default; an omitted key is left
/// alone.
fn workspace_settings_update_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "minProperties": 1,
        "properties": {
            "welcomePrompt": {"type": "string", "maxLength": WELCOME_PROMPT_PROPOSAL_MAX_BYTES},
            "roleLabels": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string", "minLength": 1, "maxLength": ROLE_LABEL_MAX_BYTES},
                    "admin": {"type": "string", "minLength": 1, "maxLength": ROLE_LABEL_MAX_BYTES},
                    "member": {"type": "string", "minLength": 1, "maxLength": ROLE_LABEL_MAX_BYTES},
                    "guest": {"type": "string", "minLength": 1, "maxLength": ROLE_LABEL_MAX_BYTES}
                }
            }
        }
    })
}

/// A proposal names at most this many channels.
pub const GRANT_CHANNELS_MAX: u64 = 5;

/// `hosted.channels.grant` arguments (증보 V2): channel **names** only. There is
/// no connection argument — the target is the proposer's own live connection.
fn hosted_channels_grant_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["channels"],
        "properties": {
            "channels": {
                "type": "array",
                "minItems": 1,
                "maxItems": GRANT_CHANNELS_MAX,
                "items": {"type": "string", "minLength": 1, "maxLength": CHANNEL_REF_MAX_BYTES}
            }
        }
    })
}

/// A channel reference: `#` + the 80-character name.
pub const CHANNEL_REF_MAX_BYTES: u64 = 81;

/// `team_ai.roles.set` arguments (ADR-0201 증보 v3 B3-T, #4964): one bundle and the switch.
/// The enum is the six **switchable** bundles — `chat_read` is not on it, and the
/// normaliser refuses it by name as well (a schema is a hint to the model, not the gate).
fn team_ai_roles_set_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["bundle", "enabled"],
        "properties": {
            "bundle": {"type": "string", "enum": crate::team_ai_roles::SWITCHABLE_BUNDLES},
            "enabled": {"type": "boolean"}
        }
    })
}

/// `workspace.unfurl.update` arguments (ADR-0201 증보 v2 H6-1): the one switch
/// `PUT …/unfurl-settings` takes.
fn workspace_unfurl_update_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["enabled"],
        "properties": {
            "enabled": {"type": "boolean"}
        }
    })
}

/// `workspace.memory.update` arguments (ADR-0201 증보 v2 H6-1): `enabled` may only
/// be **false** (a card can turn team memory off, never on) and `paused` either
/// way; at least one of the two.
fn workspace_memory_update_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "minProperties": 1,
        "properties": {
            "enabled": {"type": "boolean", "const": false},
            "paused": {"type": "boolean"}
        }
    })
}

/// The modes `PUT …/work-tier-policy` accepts (`momo_settings::validated_tier_mode`).
pub const WORK_TIER_MODES: [&str; 3] = ["t1_only", "ask", "auto"];
/// `autoTarget` in bytes: `cloud` or a work host id (a UUID is 36), with room.
pub const WORK_TIER_AUTO_TARGET_MAX_BYTES: u64 = 64;

/// `workspace.work_tier.update` arguments (ADR-0201 증보 v2 H6-1): the workspace
/// default's `mode`, and `autoTarget` (`cloud` or a workspace-scoped work host id)
/// exactly when `mode` is `auto` — the REST validator's cross-field rule.
fn workspace_work_tier_update_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["mode"],
        "properties": {
            "mode": {"type": "string", "enum": WORK_TIER_MODES},
            "autoTarget": {
                "type": "string",
                "minLength": 1,
                "maxLength": WORK_TIER_AUTO_TARGET_MAX_BYTES
            }
        }
    })
}

/// The official apps `plugin.install` may name, with the name a sentence uses
/// (ADR-0201 증보 v2 H7; the ids are ADR-0113 증보 P2's official four, held equal to
/// the server's `routes::plugins::OFFICIAL_PLUGIN_IDS` by a drift test).
pub const PLUGIN_INSTALL_PLUGINS: [(&str, &str); 7] = [
    ("com.momo.plugins.github", "GitHub"),
    ("com.momo.plugins.notion", "Notion"),
    ("com.momo.plugins.linear", "Linear"),
    ("com.momo.plugins.drive", "Google Drive"),
    ("com.momo.plugins.gmail", "Gmail"),
    ("com.momo.plugins.google-calendar", "Google Calendar"),
    ("com.momo.plugins.google-drive", "Google 내 드라이브"),
];

/// `plugin.install`'s contract (ADR-0201 증보 v2 H7; the row is in [`ACTIONS`] since
/// #3889): an Admin decides, there is no one-time value.
pub const PLUGIN_INSTALL_REQUIRED_ROLE: RequiredRole = RequiredRole::Admin;
pub const PLUGIN_INSTALL_SECRET_DELIVERY: SecretDelivery = SecretDelivery::None;
/// What approving it does. Tokens stay on the agent host (ADR-0113 D1-A).
pub const PLUGIN_INSTALL_EFFECT: &str =
    "워크스페이스에 표시된 앱을 설치해요. 토큰은 oort에 저장하지 않아요";

/// `plugin.install` arguments (H7): one official plugin id.
pub fn plugin_install_args_schema() -> Value {
    let ids: Vec<&str> = PLUGIN_INSTALL_PLUGINS.iter().map(|(id, _)| *id).collect();
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["pluginId"],
        "properties": {
            "pluginId": {"type": "string", "enum": ids}
        }
    })
}

/// The name a sentence uses for an official plugin id, `None` for any other id.
pub fn plugin_install_label(plugin_id: &str) -> Option<&'static str> {
    PLUGIN_INSTALL_PLUGINS
        .iter()
        .find(|(id, _)| *id == plugin_id)
        .map(|(_, label)| *label)
}

/// The team AI's system-prompt instruction for an app request (H7).
///
/// Installing is a card an admin approves; connecting (a grant) is never a card —
/// it is the asking member's own consent, given in their apps screen (ADR-0113 D2),
/// and the helper neither asks for nor receives a token (D1-A). An app outside the
/// official four gets the same plain refusal as any other change the helper cannot
/// make.
pub fn plugin_install_prompt_line() -> String {
    let labels: Vec<&str> = PLUGIN_INSTALL_PLUGINS
        .iter()
        .map(|(_, label)| *label)
        .collect();
    format!(
        "앱({}) 설치를 부탁받으면 `{ACTION_PLUGIN_INSTALL}`로 제안해(`pluginId`는 그 앱 하나). \
         설치는 관리자가 승인해야 돼. 앱 연결(내 권한 허용)은 카드가 아니라 부탁한 사람이 설정의 앱 \
         화면에서 직접 해. 이 밖의 앱은 아직 설치할 수 없다고 말하고, 토큰이나 키는 묻지 마.",
        labels.join("·")
    )
}

/// How an app stands in the workspace when its install card is drawn — the card's
/// 「현재」 half (ADR-0186 D3: before → after in plain words).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginInstallBefore {
    /// No install row.
    NotInstalled,
    /// Installed but switched off.
    Disabled,
    /// Installed once and uninstalled since (its grants went with it).
    Removed,
}

impl PluginInstallBefore {
    pub fn word(self) -> &'static str {
        match self {
            PluginInstallBefore::NotInstalled => "설치 안 됨",
            PluginInstallBefore::Disabled => "설치됨(꺼짐)",
            PluginInstallBefore::Removed => "설치 해제됨",
        }
    }

    pub fn as_pin(self) -> &'static str {
        match self {
            PluginInstallBefore::NotInstalled => "not_installed",
            PluginInstallBefore::Disabled => "disabled",
            PluginInstallBefore::Removed => "removed",
        }
    }
}

/// The `plugin.install` card rows: which app and version, **where it reaches out
/// to** (ADR-0113 D5 — the approver reads the egress before consenting), and its
/// state before → after. Everything but the label comes from the registry
/// manifest the resolver read, bounded and charset-checked there; the label is the
/// static [`PLUGIN_INSTALL_PLUGINS`] name, never text an agent supplied.
pub fn plugin_install_rows(
    label: &str,
    version: &str,
    egress_domains: &[String],
    before: PluginInstallBefore,
) -> Vec<Value> {
    vec![
        action_row("앱", format!("{label} {version}")),
        action_row(
            "연결 대상",
            if egress_domains.is_empty() {
                "없음".to_string()
            } else {
                egress_domains.join(", ")
            },
        ),
        action_row("상태", format!("{} → 설치됨(켜짐)", before.word())),
        action_row("연결", "각자 설정의 앱 화면에서 내 권한을 직접 허용해요"),
    ]
}

/// The card's summary sentence, with the app named (H7: 「워크스페이스에 ○○ 앱을
/// 설치해요. 토큰은 oort에 저장하지 않아요」).
pub fn plugin_install_summary(label: &str) -> String {
    format!(
        "에이전트가 제안했어요. 승인하면 {} 권한으로 워크스페이스에 {label} 앱을 설치해요. \
         토큰은 oort에 저장하지 않아요.",
        PLUGIN_INSTALL_REQUIRED_ROLE.korean()
    )
}

/// The outcome line of `plugin.install`.
pub fn plugin_install_result_body(label: &str) -> String {
    format!("{label} 앱을 설치했어요")
}

/// The outcome rows of `plugin.install`: the app, where it reaches, and what comes
/// next (the install alone gives no agent any access — each member connects).
pub fn plugin_install_result_rows(
    label: &str,
    version: &str,
    egress_domains: &[String],
) -> Vec<Value> {
    vec![
        action_row("앱", format!("{label} {version}")),
        action_row(
            "연결 대상",
            if egress_domains.is_empty() {
                "없음".to_string()
            } else {
                egress_domains.join(", ")
            },
        ),
        action_row(
            "다음",
            "각자 설정의 앱 화면에서 내 권한을 허용하면 에이전트가 써요",
        ),
    ]
}

// ---------------------------------------------------------------------------
// message.pin / message.unpin (ADR-0186 증보 v5 U-e, #4703)
// ---------------------------------------------------------------------------

/// `ref.type` for the message a pin action changed (its id).
pub const REF_TYPE_MESSAGE: &str = "message";

/// How many characters of the message the card quotes. The card is a consent, so the quote is
/// short and the card also says how long the message really is ([`PinCardMessage::total_chars`]).
pub const PIN_CARD_EXCERPT_CHARS: usize = 120;

/// `message.pin` / `message.unpin` arguments: **one id and nothing else.** No channel, no
/// URL, no text — the server reads the channel, the author and the words from the stored
/// message, so no string an agent wrote can become the card's description of its target.
fn message_pin_args_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["messageId"],
        "properties": {
            "messageId": {
                "type": "string",
                "format": "uuid",
                "description": "The id of a text message in THIS conversation (the `id` oort_conversation_read gives, or the `messageId` oort_message_post answers). A message anywhere else, a deleted one, a system or card line, or (for message.unpin) one that is not pinned is refused with the same answer."
            }
        }
    })
}

/// What the card says about the message a pin names. **Every field is the server's reading of
/// the stored row**; the proposing agent supplies only the id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinCardMessage {
    /// Empty for a DM (`channel.name` is NULL there); the rows of a DM card never print it.
    pub channel_name: String,
    /// `public`, `private` or `dm` — a DM is called 「1:1 대화」 and has no 공개 범위 row.
    pub channel_kind: String,
    /// [`member_card_label`] of the author.
    pub author_label: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// The body's first [`PIN_CARD_EXCERPT_CHARS`] characters, as [`pin_card_excerpt`] cut them.
    pub excerpt: String,
    /// The body's length in characters; `None` for a message with no text (attachments only).
    pub total_chars: Option<i64>,
    pub truncated: bool,
    pub attachment_count: i64,
    /// Pins the channel holds now, of [`MESSAGE_PIN_CHANNEL_LIMIT`].
    pub pinned_count: i64,
    /// Who pinned it and when — only a `message.unpin` card has them.
    pub pinned_by_label: Option<String>,
    pub pinned_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// A channel holds at most this many pins (`momo_messaging::CHANNEL_PIN_LIMIT`, migration 062).
/// Written here only to draw 「n/100」; the limit itself is enforced by the pin function and the
/// trigger, never by this number.
pub const MESSAGE_PIN_CHANNEL_LIMIT: i64 = 100;

/// The quote of a message body for a card: `(excerpt, total characters, was it cut)`.
///
/// Plain text, one line: every control character (a newline, a tab, an escape) becomes a space,
/// the characters that reorder or hide text (bidi controls, zero-width marks, the BOM) are
/// dropped, and runs of spaces collapse — so a message cannot draw a second row, a fake button
/// line or reversed text on a card that exists to be read. `total` is the length of the message
/// **as written**, because that is the number the approver weighs the quote against.
pub fn pin_card_excerpt(body: &str) -> (String, usize, bool) {
    let total = body.chars().count();
    let mut cleaned = String::with_capacity(body.len().min(512));
    let mut previous_space = true;
    for ch in body.chars() {
        let hidden = matches!(
            ch,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        );
        if hidden {
            continue;
        }
        let ch = if ch.is_control() || ch.is_whitespace() {
            ' '
        } else {
            ch
        };
        if ch == ' ' {
            if previous_space {
                continue;
            }
            previous_space = true;
        } else {
            previous_space = false;
        }
        cleaned.push(ch);
    }
    let cleaned = cleaned.trim_end().to_string();
    let length = cleaned.chars().count();
    if length > PIN_CARD_EXCERPT_CHARS {
        let cut: String = cleaned.chars().take(PIN_CARD_EXCERPT_CHARS).collect();
        (format!("{}…", cut.trim_end()), total, true)
    } else {
        (cleaned, total, false)
    }
}

fn pin_time_text(at: chrono::DateTime<chrono::Utc>) -> String {
    at.format("%Y-%m-%d %H:%M UTC").to_string()
}

/// The `message.pin` / `message.unpin` card rows, from the message the server read.
pub fn message_pin_rows(unpin: bool, message: &PinCardMessage) -> Vec<Value> {
    let mut rows = Vec::new();
    if message.channel_kind == "dm" {
        rows.push(action_row("채널", "이 대화"));
    } else {
        rows.push(action_row("채널", format!("#{}", message.channel_name)));
        rows.push(action_row(
            "공개 범위",
            if message.channel_kind == "public" {
                "공개"
            } else {
                "비공개"
            },
        ));
    }
    rows.push(action_row("쓴 사람", message.author_label.clone()));
    rows.push(action_row("쓴 시각", pin_time_text(message.created_at)));
    rows.push(action_row(
        "내용",
        if message.excerpt.is_empty() {
            "(본문 없음)".to_string()
        } else {
            message.excerpt.clone()
        },
    ));
    match message.total_chars {
        Some(total) => rows.push(action_row("글자 수", format!("{total}자"))),
        None => rows.push(action_row(
            "첨부",
            format!("{}개 (본문 없음)", message.attachment_count),
        )),
    }
    if message.truncated {
        rows.push(action_row(
            "전문",
            "내용이 길어요. 앱에서 이 메시지를 열어 전문을 읽은 뒤 승인해요",
        ));
    }
    if unpin {
        if let Some(by) = &message.pinned_by_label {
            rows.push(action_row("고정한 사람", by.clone()));
        }
        if let Some(at) = message.pinned_at {
            rows.push(action_row("고정한 시각", pin_time_text(at)));
        }
    }
    rows.push(action_row(
        "지금 고정된 수",
        format!("{}/{MESSAGE_PIN_CHANNEL_LIMIT}", message.pinned_count),
    ));
    rows
}

/// The card's structured preview (`props.action.preview`): the ids a client needs to open the
/// message in the app and read it whole, and the size the approver is weighing. Ids are not
/// secrets to somebody who can already read the room.
pub fn message_pin_preview(message_id: Uuid, channel_id: Uuid, message: &PinCardMessage) -> Value {
    json!({
        "kind": "message",
        "messageId": message_id.to_string(),
        "channelId": channel_id.to_string(),
        "totalChars": message.total_chars,
        "truncated": message.truncated,
    })
}

/// The outcome line of a pin action. **The id is in the body on purpose** (the agent reads this
/// line on its next turn, like `channel.create`'s): `changed` is false when the message was
/// already in the asked state, which is a success.
pub fn message_pin_result_body(unpin: bool, changed: bool, message_id: Uuid) -> String {
    match (unpin, changed) {
        (false, true) => format!("메시지를 고정했어요 · id {message_id}"),
        (false, false) => format!("이미 고정돼 있던 메시지예요 · id {message_id}"),
        (true, true) => format!("메시지 고정을 풀었어요 · id {message_id}"),
        (true, false) => format!("이미 고정이 풀려 있던 메시지예요 · id {message_id}"),
    }
}

/// The result rows of a pin action: where, and how many pins the channel holds after.
pub fn message_pin_result_rows(message: &PinCardMessage, pinned_after: i64) -> Vec<Value> {
    let mut rows = vec![if message.channel_kind == "dm" {
        action_row("채널", "이 대화")
    } else {
        action_row("채널", format!("#{}", message.channel_name))
    }];
    rows.push(action_row(
        "지금 고정된 수",
        format!("{pinned_after}/{MESSAGE_PIN_CHANNEL_LIMIT}"),
    ));
    rows
}

/// The complete registry. Order is the catalog's order.
pub const ACTIONS: &[WorkspaceAction] = &[
    WorkspaceAction {
        id: ACTION_INVITE_CREATE,
        title: "팀원 초대 링크 만들기",
        summary: "역할과 사용 횟수, 만료를 정해 초대 링크를 하나 만들어요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::Always,
        proposers: Proposers::Any,
        initiative: false,
        effect: "초대 링크를 만들어요",
        question: "팀원 초대 링크를 만들어도 될까요?",
        done: "초대 링크를 만들었어요",
        args_schema: invite_create_args_schema,
    },
    WorkspaceAction {
        id: ACTION_CHANNEL_CREATE,
        title: "채널 만들기",
        summary: "이름과 공개 범위를 정해 채널을 하나 만들고, 이 에이전트와 정한 멤버를 넣어요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: true,
        effect: "채널을 만들고, 표시된 대로 이 에이전트와 멤버를 그 채널에 넣어요",
        question: "채널을 만들어도 될까요?",
        done: "채널을 만들었어요",
        args_schema: channel_create_args_schema,
    },
    WorkspaceAction {
        id: ACTION_CHANNEL_MEMBER_ADD,
        title: "채널에 멤버 추가",
        summary: "이 에이전트가 볼 수 있는 채널에 멤버를 넣어요. 역할은 멤버로 고정돼요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: true,
        effect: "표시된 멤버를 그 채널에 넣어요",
        question: "채널에 멤버를 추가해도 될까요?",
        done: "멤버를 추가했어요",
        args_schema: channel_member_add_args_schema,
    },
    WorkspaceAction {
        id: ACTION_AGENT_RENAME,
        title: "에이전트 이름 바꾸기",
        summary: "에이전트 한 명의 표시 이름을 바꿔요. 자기 자신이나 같은 소유자의 에이전트만 대상이 돼요.",
        risk: Risk::Approval,
        required_role: RequiredRole::AgentEditor,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: false,
        effect: "대상 에이전트의 표시 이름을 바꿔요",
        question: "에이전트 이름을 바꿔도 될까요?",
        done: "에이전트 이름을 바꿨어요",
        args_schema: agent_rename_args_schema,
    },
    WorkspaceAction {
        id: ACTION_HOSTED_CHANNELS_GRANT,
        title: "에이전트가 읽고 쓸 채널 늘리기",
        summary: "이 에이전트의 연결이 읽고 쓸 수 있는 채널을 늘려요. 이 에이전트 자신의 연결만 대상이에요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: false,
        effect: "이 에이전트의 연결이 표시된 채널을 읽고 쓸 수 있게 해요",
        question: "에이전트가 읽고 쓸 채널을 늘려도 될까요?",
        done: "읽고 쓸 채널을 늘렸어요",
        args_schema: hosted_channels_grant_args_schema,
    },
    WorkspaceAction {
        id: ACTION_WORKSPACE_SETTINGS_UPDATE,
        title: "워크스페이스 문구 설정 바꾸기",
        summary: "환영 문구와 역할 이름, 이 두 가지만 바꿔요. 지우려면 null을 보내요.",
        risk: Risk::Approval,
        required_role: RequiredRole::WorkspaceOperator,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: false,
        effect: "표시된 설정(환영 문구·역할 이름)을 바꿔요",
        question: "워크스페이스 문구 설정을 바꿔도 될까요?",
        done: "문구 설정을 바꿨어요",
        args_schema: workspace_settings_update_args_schema,
    },
    WorkspaceAction {
        id: ACTION_AGENT_PROFILE_UPDATE,
        title: "에이전트 프로필 바꾸기",
        summary: "에이전트 한 명의 이름·사진·소개·상태 문구·역할 라벨을 바꿔요. 자기 자신이나 같은 소유자의 에이전트만 대상이에요.",
        risk: Risk::Approval,
        required_role: RequiredRole::AgentEditor,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: false,
        effect: "대상 에이전트의 프로필(표시된 항목)을 바꿔요",
        question: "에이전트 프로필을 바꿔도 될까요?",
        done: "프로필을 바꿨어요",
        args_schema: agent_profile_update_args_schema,
    },
    WorkspaceAction {
        id: ACTION_AGENT_INVITE,
        title: "외부 에이전트 데려오기",
        summary: "새 에이전트를 만들고 연결 코드를 발급해요. 승인한 관리자가 소유자가 되고, 연결은 사람이 확인하기 전까지 열리지 않아요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        // The approver chooses at decision time (`deliverSecretToAgent`, default off).
        secret_delivery: SecretDelivery::OptIn,
        proposers: Proposers::Any,
        initiative: false,
        effect: "표시된 이름의 새 에이전트를 만들고, 승인한 사람이 소유자가 돼요",
        question: "외부 에이전트를 데려와도 될까요?",
        done: "에이전트를 만들었어요",
        args_schema: agent_invite_args_schema,
    },
    WorkspaceAction {
        id: ACTION_MEMBER_AVATAR_SET,
        title: "내 프로필 사진 바꾸기",
        summary: "이 대화에 보낸 사진이나 에이전트가 가져온 이미지로 내 프로필 사진을 바꿔요. 요청한 본인만 승인할 수 있어요.",
        risk: Risk::Approval,
        required_role: RequiredRole::RequestingMember,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: false,
        effect: "카드에 보이는 이미지로 내 프로필 사진을 바꿔요",
        question: "내 프로필 사진을 바꿔도 될까요?",
        done: "프로필 사진을 바꿨어요",
        args_schema: member_avatar_set_args_schema,
    },
    WorkspaceAction {
        id: ACTION_MEMBER_DISPLAY_NAME_SET,
        title: "내 이름 바꾸기",
        summary: "말을 건 본인의 표시 이름을 바꿔요. 요청한 본인만 승인할 수 있고, 핸들과 과거 멘션은 그대로예요.",
        risk: Risk::Approval,
        required_role: RequiredRole::RequestingMember,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: false,
        effect: "카드에 보이는 이름으로 내 표시 이름을 바꿔요",
        question: "내 이름을 바꿔도 될까요?",
        done: "이름을 바꿨어요",
        args_schema: member_display_name_set_args_schema,
    },
    // ADR-0186 증보 v5 U-e: the pin a person does by hand, done as the approver. Admin, not
    // "any channel member": a new role would grow `RequiredRole`, the gate plan, the push
    // audience and the client's role table together (V4-3), and the existing `Admin` costs none.
    WorkspaceAction {
        id: ACTION_MESSAGE_PIN,
        title: "메시지 고정",
        summary: "이 대화의 메시지 하나를 채널 맨 위에 고정해요. 카드에 보이는 메시지만 대상이에요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: true,
        effect: "표시된 메시지를 그 채널에 고정해요",
        question: "메시지 하나를 고정해도 될까요?",
        done: "메시지를 고정했어요",
        args_schema: message_pin_args_schema,
    },
    WorkspaceAction {
        id: ACTION_MESSAGE_UNPIN,
        title: "메시지 고정 풀기",
        summary: "이 대화에서 고정된 메시지 하나의 고정을 풀어요. 카드에 보이는 메시지만 대상이에요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: true,
        effect: "표시된 메시지의 고정을 풀어요",
        question: "메시지 고정을 풀어도 될까요?",
        done: "고정을 풀었어요",
        args_schema: message_pin_args_schema,
    },
    // ADR-0186 증보 v8: a team-library picture, chosen by a person who saw the stored pixels.
    WorkspaceAction {
        id: ACTION_EXPRESSION_CREATE,
        title: "팀 표현 추가",
        summary: "에이전트가 찾았거나 만든 그림 후보(최대 4개) 중 하나를 팀 보관함에 저장해요. 저장될 그림을 직접 보고 고르며, 얼굴이 있으면 그 본인만 승인할 수 있어요.",
        risk: Risk::Approval,
        required_role: RequiredRole::ExpressionAdder,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::Any,
        initiative: false,
        effect: "카드에서 고른 그림 하나를 팀 보관함에 저장해요",
        question: "팀 표현을 추가해도 될까요?",
        done: "팀 표현을 추가했어요",
        args_schema: expression_create_args_schema,
    },
    WorkspaceAction {
        id: ACTION_WORKSPACE_UNFURL_UPDATE,
        title: "링크 미리보기 켜고 끄기",
        summary: "워크스페이스 메시지의 링크 미리보기를 켜거나 꺼요.",
        risk: Risk::Approval,
        required_role: RequiredRole::WorkspaceOperator,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::TeamAiOnly,
        initiative: false,
        effect: "워크스페이스의 링크 미리보기를 표시된 대로 바꿔요",
        question: "링크 미리보기를 바꿔도 될까요?",
        done: "링크 미리보기를 바꿨어요",
        args_schema: workspace_unfurl_update_args_schema,
    },
    WorkspaceAction {
        id: ACTION_WORKSPACE_MEMORY_UPDATE,
        title: "팀 기억 끄기·멈추기",
        summary: "워크스페이스의 팀 기억을 끄거나 잠시 멈춰요. 켜는 일은 설정 화면에서 해요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::TeamAiOnly,
        initiative: false,
        effect: "워크스페이스의 팀 기억을 표시된 대로 끄거나 멈춰요",
        question: "팀 기억을 끄거나 멈춰도 될까요?",
        done: "팀 기억을 끄거나 멈췄어요",
        args_schema: workspace_memory_update_args_schema,
    },
    WorkspaceAction {
        id: ACTION_WORKSPACE_WORK_TIER_UPDATE,
        title: "작업 이어가기 방식 바꾸기",
        summary: "호스트 연결이 끊겼을 때 작업을 어떻게 이어갈지, 워크스페이스 기본값을 바꿔요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::TeamAiOnly,
        initiative: false,
        effect: "워크스페이스 기본 작업 이어가기 방식을 표시된 대로 바꿔요",
        question: "작업 이어가기 방식을 바꿔도 될까요?",
        done: "작업 이어가기 방식을 바꿨어요",
        args_schema: workspace_work_tier_update_args_schema,
    },
    // ADR-0201 증보 v2 H7, opened by #3889: the install route (ADR-0113 P3, #3914)
    // exists, and approving runs its domain function as the approver. Helper only,
    // like the other v2 additions: external agents were not asked for this.
    WorkspaceAction {
        id: ACTION_PLUGIN_INSTALL,
        title: "앱 설치",
        summary: "공식 앱 하나를 워크스페이스에 설치해요. 토큰은 oort에 저장하지 않아요.",
        risk: Risk::Approval,
        required_role: PLUGIN_INSTALL_REQUIRED_ROLE,
        secret_delivery: PLUGIN_INSTALL_SECRET_DELIVERY,
        proposers: Proposers::TeamAiOnly,
        initiative: false,
        effect: PLUGIN_INSTALL_EFFECT,
        question: "앱을 설치해도 될까요?",
        done: "앱을 설치했어요",
        args_schema: plugin_install_args_schema,
    },
    // ADR-0201 증보 v3 B3-T: 「파일 역할 꺼 줘」 in a chat becomes this card, and an admin approves.
    // Admin and not `WorkspaceOperator`: the people who may switch the helper's reach are the
    // workspace's own owners and admins, not a platform-operator credential.
    WorkspaceAction {
        id: ACTION_TEAM_AI_ROLES_SET,
        title: "도우미 역할 켜고 끄기",
        summary: "도우미가 할 수 있는 일의 묶음 하나를 켜거나 꺼요. 한 카드에 묶음 하나만 바꿔요.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::TeamAiOnly,
        initiative: false,
        effect: "도우미의 역할 묶음 하나를 표시된 대로 켜거나 꺼요",
        question: "도우미 역할을 바꿔도 될까요?",
        done: "도우미 역할을 바꿨어요",
        args_schema: team_ai_roles_set_args_schema,
    },
    WorkspaceAction {
        id: ACTION_DM_AGENT_ADMIT,
        title: "에이전트 들이기",
        summary: "대화의 다른 사람이 모두 허락하면 에이전트가 들어와 이후 대화를 봐요.",
        risk: Risk::Approval,
        required_role: RequiredRole::DmParticipant,
        secret_delivery: SecretDelivery::None,
        proposers: Proposers::ServerOnly,
        initiative: false,
        effect: "대화의 다른 사람이 모두 허락하면 에이전트를 이 대화에 들여요",
        question: "에이전트를 이 대화에 들여도 될까요?",
        done: "에이전트를 들였어요",
        args_schema: || json!({"type": "object", "additionalProperties": false, "properties": {}}),
    },
];

/// An action the product already performs over REST that is **not** proposable
/// yet, and the sentence that says why.
///
/// The same discipline `crate::tools::DECLARED_NOT_EXECUTABLE` follows: the next
/// batch starts from a written list instead of a guess, and `GET …/actions`
/// publishes these rows with `executable: false` so a client never has to invent
/// its own explanation for an absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeclaredAction {
    pub id: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    /// Required whenever `executable` is false — the #2016 catalog contract.
    ///
    /// A row without one would make a client invent its own explanation for an
    /// absence, and every client would invent a different one.
    pub unavailable_reason: &'static str,
}

pub const DECLARED_NOT_EXECUTABLE: &[DeclaredAction] = &[
    DeclaredAction {
        id: "webhook.create",
        title: "채널 웹훅 발급",
        summary: "채널로 들어오는 웹훅 자격을 하나 발급합니다.",
        unavailable_reason: "웹훅 마스터키 분리(ADR-0004 증보 4)가 랜딩한 뒤에 열립니다.",
    },
    DeclaredAction {
        id: ACTION_MEMBER_ROLE_SET,
        title: "멤버 역할 변경",
        summary: "한 멤버의 워크스페이스 역할을 바꿉니다.",
        unavailable_reason: "다음 배치에서 열립니다.",
    },
];

/// The declared row for `id`, if it is declared but not executable.
pub fn declared_action(id: &str) -> Option<&'static DeclaredAction> {
    DECLARED_NOT_EXECUTABLE
        .iter()
        .find(|declared| declared.id == id)
}

/// The registry's ids, in catalog order. The propose schema's enum and the
/// OpenAPI enum are measured against exactly this.
pub fn action_ids() -> Vec<&'static str> {
    ACTIONS.iter().map(|action| action.id).collect()
}

/// The ids a proposal through `door` may name, in catalog order. The Agent Port's
/// `oort_action_propose` enum is measured against the [`ProposalDoor::AgentPort`]
/// list; [`TEAM_AI_ACTION_IDS`] is a subset of the [`ProposalDoor::TeamAi`] one.
pub fn proposable_action_ids(door: ProposalDoor) -> Vec<&'static str> {
    ACTIONS
        .iter()
        .filter(|action| action.proposable_through(door))
        .map(|action| action.id)
        .collect()
}

/// The action `id` names **if a proposal through `door` may raise it**, or `None`.
/// A team-AI-only id through the Agent Port answers exactly like an unknown id.
pub fn proposable_action_by_id(id: &str, door: ProposalDoor) -> Option<&'static WorkspaceAction> {
    action_by_id(id).filter(|action| action.proposable_through(door))
}

/// The ids an agent may raise **unasked**, in catalog order (ADR-0186 증보 v5 U-b-2). Exactly
/// `{channel.create, channel.member.add, message.pin, message.unpin}`; the Agent Port's
/// `oort_action_initiate` enum and OpenAPI's `InitiativeActionId` are measured against this.
pub fn initiative_action_ids() -> Vec<&'static str> {
    ACTIONS
        .iter()
        .filter(|action| action.initiative)
        .map(|action| action.id)
        .collect()
}

/// The action `id` names **if an agent may raise it unasked**, or `None` — and `None` is the one
/// answer for an unknown id, a team-AI-only id and every id that is proposable but not
/// initiative, so the tool cannot be used to ask which actions exist.
pub fn initiative_action_by_id(id: &str) -> Option<&'static WorkspaceAction> {
    action_by_id(id)
        .filter(|action| action.initiative && action.proposable_through(ProposalDoor::AgentPort))
}

/// The action `id` names, or `None`.
///
/// An unknown id and a declared-but-not-executable id answer the same way, so a
/// proposal cannot be used to enumerate what a future batch will open.
pub fn action_by_id(id: &str) -> Option<&'static WorkspaceAction> {
    ACTIONS.iter().find(|action| action.id == id)
}

// ---------------------------------------------------------------------------
// the approval contract (부록 A) — payload and props
// ---------------------------------------------------------------------------

/// `approval.payload` for a workspace action.
///
/// Deliberately **not** [`crate::approval::approval_payload`]: that builder
/// exists to preserve a model's tool call byte for byte (`arguments` as the raw
/// string the provider sent) and every one of its keys is about that utterance.
/// A workspace action is not a tool call — there is no `call_id`, no provider
/// string, and nothing to replay into a model.
///
/// `resume_model` is present and **null**, which is the load-bearing part: the
/// tool-call payload's `resume_model` names the contract "the same run is
/// resumed by a new `agent_job`", and a workspace action has no resume job at
/// all (ADR-0186 D2). Writing the key as null says that explicitly rather than
/// leaving a reader to infer it from an absence.
///
/// `args` is the **normalised** object, not what the agent typed: the card and
/// the executor must agree about what "approve" means, and the only way to
/// guarantee that is for both to read the same normalised values.
pub fn workspace_action_payload(
    action_id: &str,
    args: &Value,
    rationale: Option<&str>,
    proposed_by: Uuid,
) -> Value {
    json!({
        "action": {
            "id": action_id,
            "args": args.clone(),
            "rationale": rationale,
        },
        "proposed_by": proposed_by.to_string(),
        "resume_model": Value::Null,
    })
}

/// The namespace the proposal card's idempotency key is derived in.
///
/// A fixed v5 namespace rather than a random v4, because the key has to be the
/// **same** on a retried transaction and different from every other message an
/// approval produces.
const CARD_CLIENT_MSG_NAMESPACE: Uuid = Uuid::from_bytes([
    0x0a, 0xd7, 0x01, 0x86, 0x00, 0x00, 0x50, 0x00, 0x8a, 0xc7, 0x10, 0x9e, 0x00, 0x00, 0x00, 0x01,
]);

/// The `client_msg_id` of a proposal's `approval_request` card.
///
/// **Not the approval id.** The message spine's idempotency key is
/// `(channel_id, author_member_id, client_msg_id)` with `ON CONFLICT … DO
/// NOTHING` (`message_client_idem_uniq`, `001_init.sql:185`), and every other
/// message an approval produces already shares the first two components: the
/// rejection `tool_result` (`routes::approvals::reject_run`) and the expiry one
/// (`momo_notifier::approval_sweep`) are both authored by the same agent, in the
/// same channel, keyed on `approval.id`. Keying the card on `approval.id` too
/// would make the card and the outcome line **one** row: whichever arrived
/// second would be silently dropped, and a person would watch a proposal they
/// rejected sit on the card forever with no result line under it.
///
/// So the card derives a distinct, deterministic id instead. Deterministic
/// because a retried proposal transaction must not produce a second card;
/// distinct because the outcome line must be able to exist beside it.
///
/// Those two outcome writers keep `approval.id` and are untouched here — an
/// approval ends exactly once, so the rejection and the expiry genuinely do
/// share one key space, and that sharing is correct where it is.
pub fn card_client_msg_id(approval_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &CARD_CLIENT_MSG_NAMESPACE,
        format!("card:{approval_id}").as_bytes(),
    )
}

/// One `label`/`value` row of the card's argument table.
pub fn action_row(label: &str, value: impl Into<String>) -> Value {
    json!({"label": label, "value": value.into()})
}

/// The `invite.create` card rows, built from the **normalised** arguments.
///
/// `expires_in_days` is `None` when the proposal named no expiry; the row still
/// says 7일 because that is what the statement's own default
/// (`invite_code.expires_at DEFAULT now() + interval '7 days'`) will write. A
/// card that omitted the row would ask a person to approve an expiry they were
/// never shown.
pub fn invite_create_rows(role: &str, max_uses: i32, expires_in_days: Option<i64>) -> Vec<Value> {
    vec![
        action_row("역할", role),
        action_row("사용 횟수", format!("{max_uses}회")),
        action_row(
            "만료",
            format!(
                "{}일",
                expires_in_days.unwrap_or(DEFAULT_INVITE_EXPIRES_IN_DAYS)
            ),
        ),
        // 성재 결재 3 (V3-5): the link goes to the proposing agent, not to the
        // approver, and the card says so before anyone consents.
        action_row("초대 링크", INVITE_DELIVERY_TEXT),
    ]
}

/// The `channel.create` card rows, from the **normalised** arguments and the
/// members the server resolved (display names are the server's, never the
/// agent's strings). The 「이 에이전트도 참여」 row is always present and says in
/// words what `true` widens (증보 V3: approving a channel can widen an agent's
/// reach, so the person must read it).
pub fn channel_create_rows(
    name: &str,
    kind: &str,
    topic: Option<&str>,
    add_proposer: bool,
    member_names: &[String],
) -> Vec<Value> {
    let mut rows = vec![
        action_row("채널", format!("#{name}")),
        action_row(
            "공개 범위",
            if kind == "public" {
                "공개"
            } else {
                "비공개"
            },
        ),
    ];
    if let Some(topic) = topic {
        rows.push(action_row("주제", topic));
    }
    rows.push(action_row(
        "이 에이전트도 참여",
        if add_proposer {
            "예 — 이 에이전트가 이 채널을 읽고 쓸 수 있게 돼요"
        } else {
            "아니요"
        },
    ));
    if !member_names.is_empty() {
        rows.push(action_row("함께 넣을 멤버", member_names.join(", ")));
    }
    rows
}

/// `audit_log.action` rows the 증보 actions write beside `action.approved`
/// (V6), each with its `detail.schema`.
pub const AUDIT_CHANNEL_CREATED: &str = "channel.created";
pub const AUDIT_CHANNEL_CREATED_SCHEMA: &str = "momo.channel.created.v1";
pub const AUDIT_CHANNELS_GRANTED: &str = "hosted_connection.channels_granted";
pub const AUDIT_CHANNELS_GRANTED_SCHEMA: &str = "momo.hosted_connection.channels_granted.v1";

/// How a member is named on a card: `Display (@handle)`, plus 에이전트 for an
/// agent. A display name is not unique in a workspace; the handle is.
pub fn member_card_label(display_name: &str, handle: &str, is_agent: bool) -> String {
    if is_agent {
        format!("{display_name} (@{handle}, 에이전트)")
    } else {
        format!("{display_name} (@{handle})")
    }
}

/// The `channel.member.add` card rows, from what the server found: the
/// channel's **current** name, kind and live head-count, and the members that
/// would actually be added (those already in the channel are not listed).
pub fn channel_member_add_rows(
    channel_name: &str,
    kind: &str,
    member_count: i64,
    new_member_names: &[String],
    already_in: usize,
) -> Vec<Value> {
    let mut rows = vec![
        action_row("채널", format!("#{channel_name}")),
        action_row(
            "공개 범위",
            if kind == "public" {
                "공개"
            } else {
                "비공개"
            },
        ),
        action_row("현재 인원", format!("{member_count}명")),
        action_row("추가할 멤버", new_member_names.join(", ")),
    ];
    if already_in > 0 {
        rows.push(action_row("이미 있는 멤버", format!("{already_in}명")));
    }
    rows
}

/// `audit_log.action` for each member a `channel.member.add` seated (V6).
pub const AUDIT_CHANNEL_MEMBER_ADDED: &str = "channel.member_added";
pub const AUDIT_CHANNEL_MEMBER_ADDED_SCHEMA: &str = "momo.channel.member_added.v1";

/// The outcome line of `channel.member.add`.
pub fn channel_member_add_result_body(
    channel_name: &str,
    added: usize,
    already_in: usize,
) -> String {
    if already_in > 0 {
        format!("#{channel_name}에 멤버 {added}명을 넣었어요(이미 있던 {already_in}명)")
    } else {
        format!("#{channel_name}에 멤버 {added}명을 넣었어요")
    }
}

/// The audit row a rename writes — the same name and schema the human
/// self-rename (`PATCH …/members/me`) uses, with `kind:"agent"` in the detail.
pub const AUDIT_MEMBER_RENAMED: &str = "member.renamed";
pub const AUDIT_MEMBER_RENAMED_SCHEMA: &str = "momo.member.renamed.v1";

/// `ref.type` for the workspace whose settings changed (the workspace's id).
pub const REF_TYPE_WORKSPACE_SETTINGS: &str = "workspace_settings";

/// How one settings key reads on the card: `before → after`, plain text.
/// `None` is 「(기본값)」 — the key is not set.
pub fn settings_change_row(label: &str, before: Option<&str>, after: Option<&str>) -> Value {
    // `before` and `after` arrive already rendered by the server's own display
    // function (`routes::actions::settings_display`), which quotes every
    // agent-supplied string (JSON string syntax) so that no value can pass itself
    // off as the arrow, a second setting or a second row.
    match after {
        Some(after) => action_row(label, format!("{} → {after}", before.unwrap_or("(기본값)"))),
        // A clear is labelled as one, in the row's name, so it cannot be read as
        // just another edit.
        None => action_row(
            &format!("{label} — 지움"),
            format!("{} → (기본값으로 되돌림)", before.unwrap_or("(기본값)")),
        ),
    }
}

/// The outcome line of `workspace.settings.update`: **key names only** — the
/// welcome prompt is long user text and this body is as durable as the audit row
/// (the old and new values are on the card the approver read).
pub fn workspace_settings_result_body(labels: &[&str]) -> String {
    format!("설정을 바꿨어요: {}", labels.join(", "))
}

/// `audit_log.action` of a settings write — the REST route's own name.
pub const AUDIT_WORKSPACE_SETTING_UPDATED: &str = "workspace_setting.updated";
pub const AUDIT_WORKSPACE_SETTING_UPDATED_SCHEMA: &str = "momo.workspace_setting.updated.v1";

// ---------------------------------------------------------------------------
// ADR-0201 증보 v2 H6-1 — the three helper-only settings actions
// ---------------------------------------------------------------------------

/// `audit_log.action` / schema each new executor writes: the REST route's own
/// (`PUT …/unfurl-settings`, `PATCH …/memory/settings`, `PUT …/work-tier-policy`),
/// with `via_agent` and `approval_id` added to the detail.
pub const AUDIT_UNFURL_SETTING_UPDATED: &str = "unfurl_setting.updated";
pub const AUDIT_UNFURL_SETTING_UPDATED_SCHEMA: &str = "momo.unfurl_setting.updated.v1";
pub const AUDIT_MEMORY_SETTINGS_UPDATED: &str = "memory.settings.updated";
pub const AUDIT_MEMORY_SETTINGS_UPDATED_SCHEMA: &str = "momo.memory.settings.updated.v1";
pub const AUDIT_WORK_TIER_POLICY_CHANGED: &str = "work.tier_policy.changed";
pub const AUDIT_WORK_TIER_POLICY_CHANGED_SCHEMA: &str = "momo.work_tier_policy.changed.v1";

fn on_off(enabled: bool) -> &'static str {
    if enabled {
        "켜짐"
    } else {
        "꺼짐"
    }
}

/// The `workspace.unfurl.update` card row: 「링크 미리보기: 켜짐 → 꺼짐」.
pub fn unfurl_update_rows(before: bool, after: bool) -> Vec<Value> {
    vec![action_row(
        "링크 미리보기",
        format!("{} → {}", on_off(before), on_off(after)),
    )]
}

/// The outcome line of `workspace.unfurl.update`.
pub fn unfurl_update_result_body(after: bool) -> String {
    format!("링크 미리보기를 {}어요", if after { "켰" } else { "껐" })
}

/// How a team-memory pause reads.
fn paused_word(paused: bool) -> &'static str {
    if paused {
        "멈춤"
    } else {
        "다시 시작"
    }
}

/// The `workspace.memory.update` card rows, from the arguments alone.
///
/// No 「현재 → 」 half, on purpose: the team AI proposes from the agent worker,
/// whose database role is barred from every `mem_*` table (migration 101, ADR-0196
/// D6-6), so the proposal cannot read the current switch — and the card and the
/// decision must be drawn from the same reads. The outcome card, written by the
/// approver's own transaction, shows before → after.
pub fn memory_update_rows(enabled: Option<bool>, paused: Option<bool>) -> Vec<Value> {
    let mut rows = Vec::new();
    if enabled == Some(false) {
        rows.push(action_row("팀 기억", "끄기 — 새 요약을 만들지 않아요"));
    }
    if let Some(paused) = paused {
        rows.push(action_row("팀 기억 멈춤", paused_word(paused)));
    }
    rows
}

/// The `workspace.memory.update` result rows: what the switch was and is now.
pub fn memory_update_result_rows(
    before: (bool, bool),
    after: (bool, bool),
    enabled_touched: bool,
    paused_touched: bool,
) -> Vec<Value> {
    let mut rows = Vec::new();
    if enabled_touched {
        rows.push(action_row(
            "팀 기억",
            format!("{} → {}", on_off(before.0), on_off(after.0)),
        ));
    }
    if paused_touched {
        rows.push(action_row(
            "팀 기억 멈춤",
            format!(
                "{} → {}",
                if before.1 { "멈춤" } else { "진행" },
                if after.1 { "멈춤" } else { "진행" }
            ),
        ));
    }
    rows
}

/// The outcome line of `workspace.memory.update`.
pub fn memory_update_result_body(enabled: Option<bool>, paused: Option<bool>) -> String {
    match (enabled, paused) {
        (Some(false), _) => "팀 기억을 껐어요".to_string(),
        (_, Some(true)) => "팀 기억을 멈췄어요".to_string(),
        _ => "팀 기억을 다시 시작했어요".to_string(),
    }
}

/// How a work tier mode reads — the web client's labels
/// (`packages/momo-core/src/features/settings/model.ts` `WORK_TIER_MODES`).
pub fn work_tier_mode_label(mode: &str) -> &'static str {
    match mode {
        "t1_only" => "처음 시작한 호스트에서만",
        "ask" => "연결 끊김 시 묻기",
        "auto" => "자동 재개",
        _ => "알 수 없음",
    }
}

/// The `workspace.work_tier.update` card row: mode (and target) before → after.
/// `before_target`/`after_target` arrive already rendered by the server (a host's
/// display name, quoted, or 「oort Cloud」).
pub fn work_tier_update_rows(
    before_mode: &str,
    before_target: Option<&str>,
    after_mode: &str,
    after_target: Option<&str>,
) -> Vec<Value> {
    let side = |mode: &str, target: Option<&str>| match target {
        Some(target) => format!("{} · {target}", work_tier_mode_label(mode)),
        None => work_tier_mode_label(mode).to_string(),
    };
    vec![action_row(
        "작업 이어가기",
        format!(
            "{} → {}",
            side(before_mode, before_target),
            side(after_mode, after_target)
        ),
    )]
}

/// The outcome line of `workspace.work_tier.update`.
pub fn work_tier_update_result_body(after_mode: &str) -> String {
    format!(
        "작업 이어가기 방식을 바꿨어요: {}",
        work_tier_mode_label(after_mode)
    )
}

/// `ref.type` for a widened hosted connection (the connection's id).
pub const REF_TYPE_HOSTED_CONNECTION: &str = "hosted_connection";

/// One card row per channel being granted: the server's name, kind and live
/// head-count — what the approver is letting the agent read.
pub fn grant_channel_row(name: &str, kind: &str, member_count: i64) -> Value {
    action_row(
        "채널",
        format!(
            "#{name} · {} · {member_count}명",
            if kind == "public" {
                "공개"
            } else {
                "비공개"
            }
        ),
    )
}

/// The `hosted.channels.grant` card: the channels, then 「현재 승인 채널」
/// `before개 → after개`.
pub fn hosted_channels_grant_rows(
    channels: &[(String, String, i64)],
    approved_before: usize,
    approved_after: usize,
) -> Vec<Value> {
    let mut rows: Vec<Value> = channels
        .iter()
        .map(|(name, kind, count)| grant_channel_row(name, kind, *count))
        .collect();
    rows.push(action_row(
        "승인 채널 수",
        format!("{approved_before}개 → {approved_after}개"),
    ));
    rows
}

/// The outcome line of `hosted.channels.grant`. **Channel ids are in the body**
/// so the agent can post there on its next turn; they are not secrets.
pub fn hosted_channels_grant_result_body(channels: &[(String, Uuid)], total: usize) -> String {
    let listed: Vec<String> = channels
        .iter()
        .map(|(name, id)| format!("#{name} (id {id})"))
        .collect();
    format!(
        "읽고 쓸 채널을 늘렸어요: {} · 총 {total}개",
        listed.join(", ")
    )
}

/// `ref.type` for a renamed agent (the agent's member id).
pub const REF_TYPE_AGENT: &str = "agent";
/// `ref.type` of a `member.avatar.set` result: the person whose picture changed.
pub const REF_TYPE_MEMBER: &str = "member";

/// The summary line when the target is **another** agent. 부록 A's generic line
/// would say the same thing for a self-rename and for renaming a teammate; the
/// approver must be told which one this is.
pub const AGENT_RENAME_MANAGED_SUMMARY: &str = "에이전트가 제안했어요. 승인하면 대상 에이전트의 소유자 또는 관리자 권한으로 다른 에이전트의 이름을 바꿔요.";

/// The `agent.rename` card rows from the **server's** values: who is being
/// renamed (name, handle, 에이전트) and 「현재 이름 → 새 이름」. Plain text — a
/// client must not auto-link or auto-mention either name (부록 A).
pub fn agent_rename_rows(
    target_display_name: &str,
    target_handle: &str,
    new_display_name: &str,
) -> Vec<Value> {
    vec![
        action_row(
            "대상 에이전트",
            member_card_label(target_display_name, target_handle, true),
        ),
        action_row(
            "이름 변경",
            format!("{target_display_name} → {new_display_name}"),
        ),
    ]
}

/// The `invite.create` card row that says who receives the link (V3-5).
pub const INVITE_DELIVERY_TEXT: &str = "에이전트가 이 링크를 받아 전달해요";

/// `agent.invite`'s delivery row: before the decision it names the choice, after it
/// the choice that was made (the approver reads what is executed).
pub const PAIRING_DELIVERY_PENDING_TEXT: &str = "승인할 때 고르세요 (기본: 승인한 분만 봐요)";
pub const PAIRING_DELIVERY_AGENT_TEXT: &str = "에이전트가 받아요";
pub const PAIRING_DELIVERY_APPROVER_TEXT: &str = "승인한 분만 봐요";

/// The `agent.invite` card rows from the **server's** values. Plain text.
pub fn agent_invite_rows(platform_label: &str, display_name: &str, handle: &str) -> Vec<Value> {
    vec![
        action_row("연결 코드", PAIRING_DELIVERY_PENDING_TEXT),
        action_row("플랫폼", platform_label),
        action_row("새 에이전트", member_card_label(display_name, handle, true)),
        action_row("소유자", "승인한 사람"),
        action_row(
            "연결",
            "연결 코드가 발급되고, 연결은 사람이 확인하기 전까지 열리지 않아요",
        ),
    ]
}

/// The outcome line of `agent.invite`. No code, no link.
pub fn agent_invite_result_body(display_name: &str) -> String {
    format!(
        "에이전트를 만들었어요: {display_name}. 연결 코드로 연결을 마친 뒤 사람이 확인해야 열려요"
    )
}

/// `audit_log.action` / schema of an approved `agent.invite` (V3-3): who asked, which
/// approval, which platform preset. Never the pairing code.
pub const AUDIT_AGENT_INVITED: &str = "agent.invited";
pub const AUDIT_AGENT_INVITED_SCHEMA: &str = "momo.agent.invited.v1";

/// `result.secretOnce.kind` for a hosted-agent pairing code.
pub const SECRET_ONCE_PAIRING: &str = "pairing_credential";

/// The outcome line of `agent.rename`.
pub fn agent_rename_result_body(old: &str, new: &str) -> String {
    format!("이름을 바꿨어요: {old} → {new}")
}

/// The summary line when `agent.profile.update` targets **another** agent.
pub const AGENT_PROFILE_MANAGED_SUMMARY: &str = "에이전트가 제안했어요. 승인하면 대상 에이전트의 소유자 또는 관리자 권한으로 다른 에이전트의 프로필을 바꿔요.";

/// `audit_log.action` / schema of an approved `agent.profile.update` (V3-2).
pub const AUDIT_AGENT_PROFILE_UPDATED: &str = "agent.profile.updated";
pub const AUDIT_AGENT_PROFILE_UPDATED_SCHEMA: &str = "momo.agent.profile.updated.v1";
/// An approved image avatar (ADR-0186 증보 v3 V3-2a): ids, origin, measured size and
/// a sha256 **prefix** — never the bytes.
pub const AUDIT_AGENT_AVATAR_UPDATED: &str = "agent.avatar.updated";
pub const AUDIT_AGENT_AVATAR_UPDATED_SCHEMA: &str = "momo.agent.avatar.updated.v1";

/// One 「현재 → 새 값」 row of the profile card. Both sides are the **server's**
/// values (the current one read from the row, the new one normalised), plain
/// text; an unset side reads 「없음」 and a clear reads 「지움」.
pub fn agent_profile_change_row(label: &str, before: Option<&str>, after: Option<&str>) -> Value {
    action_row(
        label,
        format!("{} → {}", before.unwrap_or("없음"), after.unwrap_or("지움")),
    )
}

/// The `agent.profile.update` card rows: who, then one row per touched field.
/// `changes` are `(label, before, after)` with `after = None` meaning a clear.
pub fn agent_profile_update_rows(
    target_display_name: &str,
    target_handle: &str,
    changes: &[(&str, Option<String>, Option<String>)],
) -> Vec<Value> {
    let mut rows = vec![action_row(
        "대상 에이전트",
        member_card_label(target_display_name, target_handle, true),
    )];
    rows.extend(changes.iter().map(|(label, before, after)| {
        agent_profile_change_row(label, before.as_deref(), after.as_deref())
    }));
    rows
}

/// The outcome line of `agent.profile.update`: the labels that changed.
pub fn agent_profile_update_result_body(labels: &[&str]) -> String {
    format!("프로필을 바꿨어요: {}", labels.join("·"))
}

/// `ref.type` for a created channel.
pub const REF_TYPE_CHANNEL: &str = "channel";

/// The outcome line of `channel.create`. **The id is in the body on purpose**:
/// the agent reads this line on its next turn and needs the channel id to post
/// there (`oort_message_post` takes a `channelId`), and a channel id is not a
/// secret (증보 V6).
pub fn channel_create_result_body(name: &str, kind: &str, channel_id: Uuid) -> String {
    format!(
        "채널을 만들었어요: #{name} ({}) · id {channel_id}",
        if kind == "public" {
            "공개"
        } else {
            "비공개"
        }
    )
}

/// The `channel.create` result rows.
pub fn channel_create_result_rows(
    name: &str,
    kind: &str,
    proposer_joined: bool,
    member_count: usize,
) -> Vec<Value> {
    vec![
        action_row("채널", format!("#{name}")),
        action_row(
            "공개 범위",
            if kind == "public" {
                "공개"
            } else {
                "비공개"
            },
        ),
        action_row(
            "이 에이전트도 참여",
            if proposer_joined { "예" } else { "아니요" },
        ),
        action_row("함께 넣은 멤버", format!("{member_count}명")),
    ]
}

/// The invite expiry the SQL default applies when a proposal names none
/// (`server/Migrations/…` `invite_code.expires_at`).
pub const DEFAULT_INVITE_EXPIRES_IN_DAYS: i64 = 7;

/// The `action` block of 부록 A.
pub fn action_block(action: &WorkspaceAction, rows: Vec<Value>, rationale: Option<&str>) -> Value {
    json!({
        "id": action.id,
        "rows": rows,
        "rationale": rationale,
        "required_role": action.required_role.as_wire(),
    })
}

/// The sentence under the card's title: what approving this **does**, and with
/// whose authority.
///
/// ## 「에이전트가」 rather than 부록 A's 「hermes가」 — a deliberate departure
///
/// ADR-0186 부록 A shows `"hermes가 제안했습니다. …"`, i.e. the proposer's name
/// inlined. This builds `"에이전트가 제안했습니다. …"` instead, for two reasons
/// the appendix's one example could not show:
///
/// * the message is **authored by that agent**, so the card already carries its
///   avatar and display name one line above. Inlining the name again would make
///   this the only place in the product where a speaker introduces themselves in
///   their own message body; and
/// * a name baked into `props.summary` is a **stale copy** — `member.display_name`
///   is mutable (`PATCH …/members/me`, #1873), and the card would keep saying
///   「hermes가」 after a rename.
///
/// The appendix's contract is the *shape* (`title` + `summary` + the `action`
/// block), which is kept exactly; AX-4 renders `summary` as an opaque string, so
/// nothing downstream reads the name out of it.
pub fn proposal_summary(action: &WorkspaceAction) -> String {
    format!(
        "에이전트가 제안했어요. 승인하면 {} 권한으로 {}.",
        action.required_role.korean(),
        action.effect
    )
}

/// The one-line body of the `approval_request` message: the action as **one question**
/// (ADR-0204 증보 6 D6-3 — 「소개를 바꿔도 될까요?」, never the English 「Approval required」 and never
/// the old 「승인 요청: {title}」).
///
/// A body rather than props alone, because props are a *rendering* affordance:
/// a client that does not know this card kind still shows the person a sentence
/// (ADR-0186 D5's fallback rule) — and it is what the push and the desktop notification say.
/// No value is quoted here; [`workspace_action_request_body_with`] is the one that knows the
/// arguments.
pub fn workspace_action_request_body(action: &WorkspaceAction) -> String {
    crate::approval_sentence::action_request_body(action, None, false)
}

/// [`workspace_action_request_body`] with what the producer knows: the arguments the server
/// validated (a `channel.create` quotes its short name and says 「비공개 채널을」 for a private one)
/// and whether the card was raised **unasked** — 「먼저 제안 · …」 (D6-3).
pub fn workspace_action_request_body_with(
    action: &WorkspaceAction,
    args: Option<&Value>,
    unasked: bool,
) -> String {
    crate::approval_sentence::action_request_body(action, args, unasked)
}

/// `message.props` for the `approval_request` row of a workspace action —
/// ADR-0186 부록 A.
///
/// The shared keys are the same ones
/// [`crate::approval::approval_request_props`] writes (`approval_id`, `run_id`,
/// `channel_id`, `action_type`, `status`, `expires_at_ms`, `title`, `summary`),
/// so one renderer draws both faces of the card and the decision route's
/// `decided_props_patch` patches this one unchanged. What separates them is the
/// `action` block: its **presence** is the discriminator (ADR-0186 §6), which is
/// why the tool-call builder is not widened to take an optional one — a
/// workspace action has no `call_id`, no `tool_name` and no `arguments` string,
/// and passing three empty ones would make the discriminator a lie.
pub fn workspace_action_request_props(
    approval_id: Uuid,
    run_id: Uuid,
    channel_id: Uuid,
    action: &WorkspaceAction,
    action_block: Value,
    expires_at: chrono::DateTime<chrono::Utc>,
) -> Value {
    json!({
        "approval_id": approval_id.to_string(),
        "run_id": run_id.to_string(),
        "channel_id": channel_id.to_string(),
        "action_type": ACTION_TYPE_WORKSPACE_ACTION,
        "status": "pending",
        "expires_at_ms": expires_at.timestamp_millis(),
        "title": action.title,
        "summary": proposal_summary(action),
        "action": action_block,
    })
}

// ---------------------------------------------------------------------------
// the outcome contract (부록 B, 부록 C) — what a decision leaves behind
// ---------------------------------------------------------------------------

/// The props key of the persistent result card (ADR-0186 부록 B).
pub const ACTION_RESULT_PROPS_KEY: &str = "momo.action_result";

/// `momo.action_result.v1`.
pub const ACTION_RESULT_VERSION: i64 = 1;

/// The executed action's result status. ADR-0186 v6 R-b puts this object
/// inside the existing approval card's `result`; rejection, expiry and human
/// cancellation use the same card, with their own status. No outcome line is
/// inserted. `role_required` remains a nonterminal attempt on a pending card.
pub const ACTION_RESULT_EXECUTED: &str = "executed";

/// The card patch a decision refused for want of authority leaves behind
/// (ADR-0186 D2: 「승인은 소모되지 않음」).
///
/// It is written onto the *request* card's props rather than posted as a
/// message, because nothing happened: the approval is still `pending`, the run
/// is still parked, and the same person — or an admin beside them — can still
/// decide it. A message would say the proposal ended.
pub const LAST_ATTEMPT_PROPS_KEY: &str = "last_attempt";

/// The one value [`LAST_ATTEMPT_PROPS_KEY`] takes today, and the `status` a
/// refused decision answers with.
///
/// The same string on the wire and in the props on purpose: the client picks
/// 「관리자가 승인해야 합니다」 from one word, wherever it read it.
pub const ROLE_REQUIRED: &str = "role_required";

/// `audit_log.action` for the approval half of an executed workspace action.
pub const AUDIT_ACTION_APPROVED: &str = "action.approved";

/// `detail.schema` of that row (ADR-0186 D2).
pub const ACTION_APPROVED_AUDIT_SCHEMA: &str = "momo.action.approved.v1";

/// `result.secretOnce.kind` for an invite link (부록 C).
pub const SECRET_ONCE_INVITE_LINK: &str = "invite_link";

/// 부록 B `next` — where the durable half of this action can be found later.
///
/// **정오표 (AX-4 #2510, this PR):** the appendix's sample says
/// `/settings?section=invites`, and there is no such section. The web client's
/// canonical nav (`clients/web/src/features/settings/settingsNav.ts:53`) has
/// `members`, labelled 「멤버와 초대」. A card whose only next step is a dead link
/// is worse than a card with no next step, so both the href and the label follow
/// the nav rather than the sample.
pub const ACTION_RESULT_NEXT_HREF: &str = "/settings?section=members";

/// The label beside [`ACTION_RESULT_NEXT_HREF`], spelled as the nav spells it.
pub const ACTION_RESULT_NEXT_LABEL: &str = "설정 › 멤버와 초대에서 보기";

/// The reserved `client_msg_id` of legacy executed-action result lines.
/// New decisions patch the request card (ADR-0186 v6 R-b); keep this key stable
/// because existing rows and future announcement keys must never collide.
///
/// **Not the approval id, and not the card's id either.** Three messages can now
/// share `(channel_id, author_member_id)` for one approval — the proposal card
/// ([`card_client_msg_id`]), the rejection/expiry `tool_result`
/// (`approval.id`, `routes::approvals::reject_run` and
/// `momo_notifier::approval_sweep`), and this one. The spine's idempotency guard
/// is `(channel, author, client_msg_id)` with `ON CONFLICT … DO NOTHING`
/// (`message_client_idem_uniq`, `001_init.sql:185`), so any two of the three
/// sharing a key would silently drop one row.
///
/// Reusing `approval.id` here would be the quietest of the three failures: an
/// approval is either approved or rejected, never both, so the collision would
/// never fire in a test that decides once — and would fire the day an expiry
/// sweep and a late approval raced, dropping the line that says a link was
/// minted while the invite itself stayed very real.
///
/// Deterministic for the same reason the card's is: a retried decision
/// transaction must post one line, not two.
pub fn result_client_msg_id(approval_id: Uuid) -> Uuid {
    Uuid::new_v5(
        &CARD_CLIENT_MSG_NAMESPACE,
        format!("result:{approval_id}").as_bytes(),
    )
}

/// What an executed action leaves on the timeline (부록 B).
///
/// A struct rather than eight positional arguments because six of them are
/// strings: `action_result_props(a, b, c, d, …)` is a call nobody can read, and
/// two of the strings are ids whose order a reader could not recover.
#[derive(Debug, Clone)]
pub struct ActionResult<'a> {
    pub action_id: &'a str,
    /// One of the 부록 B statuses — [`ACTION_RESULT_EXECUTED`] here.
    pub status: &'a str,
    pub approval_id: Uuid,
    pub decided_by: Uuid,
    /// The durable thing this produced: `("invite", <invite_id>)`.
    pub ref_type: &'a str,
    pub ref_id: Uuid,
    /// The same `label`/`value` shape the request card uses.
    pub rows: Vec<Value>,
    /// 부록 B / D4: **true** says a one-time value existed and was shown to the
    /// decider once. It is a flag, never the value — the card is durable and the
    /// value is not.
    pub secret_shown_once: bool,
    /// Where the durable half of this action can be found later, or `None` when
    /// no settings section shows it. Only `invite.create` has one today
    /// ([`ACTION_RESULT_NEXT_HREF`]); a wrong link on another action's card would
    /// be worse than none (see the 정오표 on that constant).
    pub next: Option<ActionResultNext>,
    /// ADR-0218 부록 B `Result` (`{id,name,token}`) of an executed `expression.create`: the
    /// one value that is not generic. `None` for every other action.
    pub expression: Option<Value>,
}

/// 부록 B `next` — a fixed in-app path and its label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionResultNext {
    pub label: &'static str,
    pub href: &'static str,
}

/// The invite card's `next`: the members settings section.
pub const INVITE_RESULT_NEXT: ActionResultNext = ActionResultNext {
    label: ACTION_RESULT_NEXT_LABEL,
    href: ACTION_RESULT_NEXT_HREF,
};

/// `message.props` for the `tool_result` row of an executed workspace action.
///
/// The key set is **closed and small**, and that is the security property rather
/// than a style: a props object is durable, is broadcast to every member of the
/// channel, survives a reload, and is read by clients this server has never
/// seen. ADR-0186 D4 says the one-time value lives in the decision *response*
/// body alone, so this object has no field a code or a URL could be put in —
/// `secret_shown_once` is a boolean and `next.href` is a fixed in-app path
/// ([`ACTION_RESULT_NEXT_HREF`]).
pub fn action_result_props(result: &ActionResult<'_>) -> Value {
    let mut card = json!({
        "v": ACTION_RESULT_VERSION,
        "action_id": result.action_id,
        "status": result.status,
        "approval_id": result.approval_id.to_string(),
        "decided_by": result.decided_by.to_string(),
        "ref": {"type": result.ref_type, "id": result.ref_id.to_string()},
        "rows": result.rows,
        "secret_shown_once": result.secret_shown_once,
    });
    if let (Some(next), Some(object)) = (result.next, card.as_object_mut()) {
        object.insert(
            "next".into(),
            json!({"label": next.label, "href": next.href}),
        );
    }
    if let (Some(expression), Some(object)) = (&result.expression, card.as_object_mut()) {
        object.insert("expression".into(), expression.clone());
    }
    json!({ ACTION_RESULT_PROPS_KEY: card })
}

/// The `ref` object of 부록 B and 부록 C — one shape, two carriers.
///
/// The result card's props and the decision response both name what was made,
/// and they must name it identically: a client that read the id from the
/// response and then matched it against the card would otherwise have to know
/// two spellings of the same fact.
pub fn action_ref(ref_type: &str, ref_id: Uuid) -> Value {
    json!({"type": ref_type, "id": ref_id.to_string()})
}

/// `ref.type` for a minted invite.
pub const REF_TYPE_INVITE: &str = "invite";

/// The `invite.create` result rows (부록 B): role and the **date** it dies.
///
/// The request card says 「7일」 because a relative span is what a person is
/// consenting to; the result card says a date because the span has now started
/// and 「7일」 would mean something different every day the card is re-read.
pub fn invite_result_rows(role: &str, expires_on: &str) -> Vec<Value> {
    vec![action_row("역할", role), action_row("만료", expires_on)]
}

/// The one-line body of the result message.
///
/// Says what was made and its three bounds, and **not** the link: this body is
/// as durable as the props beside it (ADR-0186 D4).
pub fn invite_result_body(role: &str, max_uses: i32, expires_in_days: i64) -> String {
    format!("초대 링크를 만들었어요({role} · {max_uses}회 · {expires_in_days}일)")
}

/// The props patch a refused decision leaves on the request card.
///
/// There is deliberately **no** "clear" form of this patch. A shallow jsonb
/// merge cannot delete a key — `{"last_attempt": null}` leaves it present
/// holding a null, and a client asking `"last_attempt" in props` would still
/// see it. So the decision that settles the card **prunes** the key instead
/// (`momo_messaging::patch_and_prune_message_props_in_tx`), and both the
/// approve and the reject arm do it: a decided card must not still say the last
/// attempt needed an admin.
pub fn last_attempt_patch(last_attempt: &str) -> Value {
    json!({ LAST_ATTEMPT_PROPS_KEY: last_attempt })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_executable_and_declared_lists_are_what_the_batch_opened() {
        assert_eq!(
            action_ids(),
            vec![
                "invite.create",
                "channel.create",
                "channel.member.add",
                "agent.rename",
                "hosted.channels.grant",
                "workspace.settings.update",
                "agent.profile.update",
                "agent.invite",
                "member.avatar.set",
                "member.display_name.set",
                "message.pin",
                "message.unpin",
                "expression.create",
                "workspace.unfurl.update",
                "workspace.memory.update",
                "workspace.work_tier.update",
                "plugin.install",
                "team_ai.roles.set",
                "dm.agent.admit"
            ]
        );
        assert_eq!(
            DECLARED_NOT_EXECUTABLE
                .iter()
                .map(|declared| declared.id)
                .collect::<Vec<_>>(),
            vec!["webhook.create", "member.role.set"]
        );
    }

    /// ADR-0201 증보 v2 H6 / H13-A13·A14 + H7 (#3889) + v3 B4 (#4965): the helper's list is H6-1's
    /// eight plus `plugin.install`, the two invite actions (the `invite_access` bundle, B4) and the
    /// roles card, every one executable; the three settings actions, `plugin.install` and the
    /// roles card are the only team-AI-only rows, so the Agent Port's list is still the v1
    /// actions — the two invites are on **both** lists, which is why the door has to be judged.
    #[test]
    fn the_team_ai_list_is_h6_plus_plugin_install_and_only_those_are_helper_only() {
        assert_eq!(
            TEAM_AI_ACTION_IDS,
            [
                "agent.profile.update",
                "agent.rename",
                "channel.create",
                "channel.member.add",
                "workspace.settings.update",
                "workspace.unfurl.update",
                "workspace.memory.update",
                "workspace.work_tier.update",
                "plugin.install",
                "member.avatar.set",
                "member.display_name.set",
                "invite.create",
                "agent.invite",
                "team_ai.roles.set",
            ]
        );
        for id in TEAM_AI_ACTION_IDS {
            assert!(
                proposable_action_by_id(id, ProposalDoor::TeamAi).is_some(),
                "{id} must be proposable by the team AI"
            );
        }
        // B15-A1: the invites are in; widening the helper's own access is not (B4-6), and
        // neither is a declared-but-not-executable action or the box.
        for id in [ACTION_INVITE_CREATE, ACTION_AGENT_INVITE] {
            assert!(TEAM_AI_ACTION_IDS.contains(&id), "{id}");
            assert!(
                proposable_action_by_id(id, ProposalDoor::AgentPort).is_some(),
                "{id}"
            );
            assert_eq!(
                action_by_id(id).map(|a| a.proposers),
                Some(Proposers::Any),
                "{id}"
            );
        }
        for banned in [
            ACTION_HOSTED_CHANNELS_GRANT,
            ACTION_MEMBER_ROLE_SET,
            ACTION_HOST_SESSION_OPEN,
            "webhook.create",
        ] {
            assert!(!TEAM_AI_ACTION_IDS.contains(&banned), "{banned}");
        }
        let helper_only: Vec<&str> = ACTIONS
            .iter()
            .filter(|action| action.proposers == Proposers::TeamAiOnly)
            .map(|action| action.id)
            .collect();
        assert_eq!(
            helper_only,
            [
                ACTION_WORKSPACE_UNFURL_UPDATE,
                ACTION_WORKSPACE_MEMORY_UPDATE,
                ACTION_WORKSPACE_WORK_TIER_UPDATE,
                ACTION_PLUGIN_INSTALL,
                ACTION_TEAM_AI_ROLES_SET
            ]
        );
        assert_eq!(
            proposable_action_ids(ProposalDoor::AgentPort),
            vec![
                "invite.create",
                "channel.create",
                "channel.member.add",
                "agent.rename",
                "hosted.channels.grant",
                "workspace.settings.update",
                "agent.profile.update",
                "agent.invite",
                "member.avatar.set",
                "member.display_name.set",
                "message.pin",
                "message.unpin",
                "expression.create"
            ]
        );
        for id in helper_only {
            assert!(
                proposable_action_by_id(id, ProposalDoor::AgentPort).is_none(),
                "{id} through the Agent Port must answer like an unknown id"
            );
            assert!(action_by_id(id).is_some(), "{id} is still in the catalog");
        }
        assert_eq!(
            proposable_action_ids(ProposalDoor::TeamAi),
            action_ids()
                .into_iter()
                .filter(|id| *id != ACTION_DM_AGENT_ADMIT)
                .collect::<Vec<_>>()
        );
        for door in [ProposalDoor::AgentPort, ProposalDoor::TeamAi] {
            assert!(
                proposable_action_by_id(ACTION_DM_AGENT_ADMIT, door).is_none(),
                "only a human DM call may raise consent"
            );
        }
    }

    /// H6-1: the memory card can only turn memory OFF — `enabled` is `const:false`
    /// in the published schema (the normaliser enforces it too).
    #[test]
    fn the_memory_schema_cannot_turn_memory_on() {
        let schema = action_by_id(ACTION_WORKSPACE_MEMORY_UPDATE)
            .expect("registered")
            .args_schema();
        assert_eq!(schema["properties"]["enabled"]["const"], json!(false));
        assert_eq!(schema["minProperties"], json!(1));
        let tier = action_by_id(ACTION_WORKSPACE_WORK_TIER_UPDATE)
            .expect("registered")
            .args_schema();
        assert_eq!(tier["properties"]["mode"]["enum"], json!(WORK_TIER_MODES));
        assert_eq!(tier["required"], json!(["mode"]));
        let unfurl = action_by_id(ACTION_WORKSPACE_UNFURL_UPDATE)
            .expect("registered")
            .args_schema();
        assert_eq!(unfurl["required"], json!(["enabled"]));
    }

    /// H7 (#3889): `plugin.install` is executable — an Admin decides, there is no
    /// one-time value, only the official four may be named, the helper alone may
    /// propose it, and the card reads in plain words with the egress on it (D5).
    #[test]
    fn plugin_install_is_an_executable_helper_only_admin_action() {
        let action = action_by_id(ACTION_PLUGIN_INSTALL).expect("registered");
        assert!(declared_action(ACTION_PLUGIN_INSTALL).is_none());
        assert_eq!(action.required_role, RequiredRole::Admin);
        assert_eq!(action.required_role, PLUGIN_INSTALL_REQUIRED_ROLE);
        assert_eq!(action.secret_delivery, SecretDelivery::None);
        assert_eq!(action.proposers, Proposers::TeamAiOnly);
        assert_eq!(action.risk, Risk::Approval);
        let schema = plugin_install_args_schema();
        assert_eq!(schema["additionalProperties"], json!(false));
        assert_eq!(schema["required"], json!(["pluginId"]));
        assert_eq!(
            schema["properties"]["pluginId"]["enum"],
            json!([
                "com.momo.plugins.github",
                "com.momo.plugins.notion",
                "com.momo.plugins.linear",
                "com.momo.plugins.drive",
                "com.momo.plugins.gmail",
                "com.momo.plugins.google-calendar",
                "com.momo.plugins.google-drive"
            ])
        );
        assert_eq!(action.args_schema(), schema);

        let egress = vec!["api.githubcopilot.com".to_string()];
        assert_eq!(
            plugin_install_rows(
                "GitHub",
                "1.0.0",
                &egress,
                PluginInstallBefore::NotInstalled
            ),
            vec![
                action_row("앱", "GitHub 1.0.0"),
                action_row("연결 대상", "api.githubcopilot.com"),
                action_row("상태", "설치 안 됨 → 설치됨(켜짐)"),
                action_row("연결", "각자 설정의 앱 화면에서 내 권한을 직접 허용해요"),
            ]
        );
        assert_eq!(
            plugin_install_rows("Google Drive", "1.0.0", &[], PluginInstallBefore::Disabled)[1],
            action_row("연결 대상", "없음"),
            "an empty egress list reads as 없음, never as a missing row"
        );
        assert_eq!(
            plugin_install_summary("GitHub"),
            "에이전트가 제안했어요. 승인하면 관리자 권한으로 워크스페이스에 GitHub 앱을 설치해요. \
             토큰은 oort에 저장하지 않아요."
        );
        assert_eq!(
            plugin_install_result_body("GitHub"),
            "GitHub 앱을 설치했어요"
        );
        assert_eq!(
            plugin_install_result_rows("GitHub", "1.0.0", &egress)[2],
            action_row(
                "다음",
                "각자 설정의 앱 화면에서 내 권한을 허용하면 에이전트가 써요"
            )
        );
        // The label comes from the static table: an id outside the four has none.
        assert_eq!(
            plugin_install_label("com.momo.plugins.github"),
            Some("GitHub")
        );
        assert_eq!(plugin_install_label("evil.plugin <@everyone>"), None);
    }

    /// The prompt names the four apps, sends installs to the card, keeps connecting
    /// out of it, and promises no route that does not exist.
    #[test]
    fn the_prompt_line_proposes_the_install_and_keeps_the_grant_with_the_member() {
        let line = plugin_install_prompt_line();
        for (_, label) in PLUGIN_INSTALL_PLUGINS {
            assert!(line.contains(label), "{line}");
        }
        assert!(line.contains(ACTION_PLUGIN_INSTALL), "{line}");
        assert!(line.contains("관리자가 승인"), "{line}");
        assert!(
            line.contains("직접"),
            "the grant stays the member's own: {line}"
        );
        assert!(!line.contains("아직 설치 경로가 없어요"), "{line}");
        assert!(!line.contains("준비되면"), "{line}");
    }

    /// The new cards say before → after in plain words, and the memory card names
    /// only what the proposal changes.
    #[test]
    fn the_new_settings_cards_read_in_plain_words() {
        assert_eq!(
            unfurl_update_rows(true, false),
            vec![action_row("링크 미리보기", "켜짐 → 꺼짐")]
        );
        assert_eq!(
            memory_update_rows(Some(false), None),
            vec![action_row("팀 기억", "끄기 — 새 요약을 만들지 않아요")]
        );
        assert_eq!(
            memory_update_rows(None, Some(true)),
            vec![action_row("팀 기억 멈춤", "멈춤")]
        );
        assert_eq!(
            work_tier_update_rows("ask", None, "auto", Some("oort Cloud")),
            vec![action_row(
                "작업 이어가기",
                "연결 끊김 시 묻기 → 자동 재개 · oort Cloud"
            )]
        );
        assert_eq!(unfurl_update_result_body(false), "링크 미리보기를 껐어요");
        assert_eq!(
            memory_update_result_body(Some(false), Some(true)),
            "팀 기억을 껐어요"
        );
    }

    /// The #2016 catalog contract: an unavailable row always says why. A blank
    /// reason would make the client invent one.
    #[test]
    fn every_declared_action_carries_a_reason_and_no_id_is_in_both_lists() {
        for declared in DECLARED_NOT_EXECUTABLE {
            assert!(
                !declared.unavailable_reason.trim().is_empty(),
                "{}",
                declared.id
            );
            assert!(!declared.title.trim().is_empty(), "{}", declared.id);
            assert!(!declared.summary.trim().is_empty(), "{}", declared.id);
            assert!(
                action_by_id(declared.id).is_none(),
                "{} cannot be both executable and declared-not-executable",
                declared.id
            );
        }
    }

    #[test]
    fn every_action_id_is_unique_and_resolvable() {
        let mut ids = action_ids();
        let total = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), total, "action identity is the id");
        for action in ACTIONS {
            assert_eq!(
                action_by_id(action.id).map(|found| found.id),
                Some(action.id)
            );
        }
        assert!(action_by_id("invite.create.evil").is_none());
        assert!(action_by_id("webhook.create").is_none());
    }

    /// Every v1 action changes the workspace, so every one of them is an
    /// approval card. `Risk::None` exists for the client-command vocabulary
    /// (ADR-0186 D3/D6) and must never appear in **this** catalog — an action
    /// that reached the server without a card would be the gate's one hole.
    #[test]
    fn every_registry_action_is_an_approval_risk() {
        for action in ACTIONS {
            assert_eq!(action.risk, Risk::Approval, "{}", action.id);
            assert_eq!(action.risk.as_wire(), "approval");
        }
        assert_eq!(Risk::None.as_wire(), "none");
    }

    #[test]
    fn every_args_schema_is_a_closed_object() {
        for action in ACTIONS {
            let schema = action.args_schema();
            assert_eq!(schema["type"], "object", "{}", action.id);
            assert_eq!(schema["additionalProperties"], false, "{}", action.id);
            assert!(schema["properties"].is_object(), "{}", action.id);
        }
    }

    /// 부록 E's bounds, checked as numbers rather than as prose: the proposal
    /// surface is narrower than the REST one it will execute through.
    #[test]
    fn the_invite_schema_is_narrower_than_the_rest_surface() {
        let schema = action_by_id(ACTION_INVITE_CREATE)
            .expect("v1")
            .args_schema();
        assert_eq!(
            schema["properties"]["role"]["enum"],
            json!(["member", "admin"])
        );
        assert_eq!(schema["properties"]["maxUses"]["minimum"], json!(1));
        assert_eq!(schema["properties"]["maxUses"]["maximum"], json!(100));
        assert_eq!(schema["properties"]["expiresInDays"]["minimum"], json!(1));
        assert_eq!(schema["properties"]["expiresInDays"]["maximum"], json!(30));
        // The published numbers ARE the constants the server enforces.
        assert_eq!(
            schema["properties"]["maxUses"]["maximum"],
            json!(INVITE_MAX_USES_CEILING)
        );
        assert_eq!(
            schema["properties"]["expiresInDays"]["maximum"],
            json!(INVITE_EXPIRES_IN_DAYS_CEILING)
        );
        assert_eq!(
            schema["properties"]["role"]["enum"],
            json!(INVITE_PROPOSABLE_ROLES)
        );
        // `guest` is a role `momo_settings::normalized_invite_role` accepts and a
        // proposal may not ask for; `owner` is refused by both. That the *REST*
        // validator is genuinely wider is measured where both are in scope
        // (`routes::actions::the_registry_ceilings_are_enforced_by_the_domain_as_well`)
        // — this crate cannot depend on `momo-settings`.
        assert!(!INVITE_PROPOSABLE_ROLES.contains(&"guest"));
        assert!(!INVITE_PROPOSABLE_ROLES.contains(&"owner"));
    }

    #[test]
    fn the_payload_names_the_proposer_and_declares_no_resume() {
        let proposer = Uuid::from_u128(7);
        let payload = workspace_action_payload(
            ACTION_INVITE_CREATE,
            &json!({"role": "member", "maxUses": 1}),
            Some("새 팀원 온보딩 요청"),
            proposer,
        );
        assert_eq!(payload["action"]["id"], json!("invite.create"));
        assert_eq!(payload["action"]["args"]["role"], json!("member"));
        assert_eq!(payload["action"]["rationale"], json!("새 팀원 온보딩 요청"));
        assert_eq!(payload["proposed_by"], json!(proposer.to_string()));
        assert!(
            payload.get("resume_model").is_some_and(Value::is_null),
            "a workspace action has no resume job, and the payload says so"
        );
        // The tool-call payload's keys are absent, which is what keeps the
        // decision route from reading this as a tool call.
        assert!(payload.get("tool_call").is_none());
        // An omitted rationale is a null, never a missing key: the card renders
        // the same shape either way.
        let anonymous = workspace_action_payload(ACTION_INVITE_CREATE, &json!({}), None, proposer);
        assert_eq!(anonymous["action"]["rationale"], Value::Null);
    }

    #[test]
    fn the_card_rows_show_the_default_expiry_that_sql_will_apply() {
        assert_eq!(
            invite_create_rows("member", 1, None),
            vec![
                json!({"label": "역할", "value": "member"}),
                json!({"label": "사용 횟수", "value": "1회"}),
                json!({"label": "만료", "value": "7일"}),
                json!({"label": "초대 링크", "value": "에이전트가 이 링크를 받아 전달해요"}),
            ]
        );
        assert_eq!(
            invite_create_rows("admin", 5, Some(30))[2],
            json!({"label": "만료", "value": "30일"})
        );
    }

    /// 부록 A, key by key. The shared half is what one renderer draws for both
    /// approval faces; `action` is the discriminator.
    #[test]
    fn the_request_props_are_appendix_a() {
        let action = action_by_id(ACTION_INVITE_CREATE).expect("v1");
        let expires_at = chrono::DateTime::from_timestamp_millis(1_700_000_000_000)
            .expect("a representable instant");
        let props = workspace_action_request_props(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            action,
            action_block(
                action,
                invite_create_rows("member", 1, Some(7)),
                Some("새 팀원 온보딩 요청"),
            ),
            expires_at,
        );
        assert_eq!(props["approval_id"], json!(Uuid::from_u128(1).to_string()));
        assert_eq!(props["run_id"], json!(Uuid::from_u128(2).to_string()));
        assert_eq!(props["channel_id"], json!(Uuid::from_u128(3).to_string()));
        assert_eq!(props["action_type"], json!("workspace_action"));
        assert_eq!(props["status"], json!("pending"));
        assert_eq!(props["expires_at_ms"], json!(1_700_000_000_000i64));
        assert_eq!(props["title"], json!("팀원 초대 링크 만들기"));
        assert_eq!(props["action"]["id"], json!("invite.create"));
        assert_eq!(props["action"]["required_role"], json!("admin"));
        assert_eq!(props["action"]["rows"][0]["label"], json!("역할"));
        assert!(props["summary"]
            .as_str()
            .expect("summary")
            .contains("관리자 권한으로"));
        // The tool-call card's keys never appear here — their absence is what
        // tells a renderer which face it is drawing.
        for absent in ["call_id", "tool_name", "arguments"] {
            assert!(props.get(absent).is_none(), "{absent}");
        }
    }

    #[test]
    fn the_channel_card_always_says_whether_the_agent_joins() {
        let rows = channel_create_rows("계획", "private", None, true, &[]);
        assert_eq!(rows[0], json!({"label": "채널", "value": "#계획"}));
        assert_eq!(rows[1], json!({"label": "공개 범위", "value": "비공개"}));
        let joins = rows
            .iter()
            .find(|row| row["label"] == "이 에이전트도 참여")
            .expect("the row is always present");
        assert!(joins["value"].as_str().expect("value").starts_with("예"));
        let rows = channel_create_rows("계획", "public", Some("주제"), false, &["김 인턴".into()]);
        let joins = rows
            .iter()
            .find(|row| row["label"] == "이 에이전트도 참여")
            .expect("the row is present for `false` too");
        assert_eq!(joins["value"], json!("아니요"));
        assert_eq!(rows[1]["value"], json!("공개"));
        assert!(rows.iter().any(|row| row["label"] == "주제"));
        assert!(rows
            .iter()
            .any(|row| row["label"] == "함께 넣을 멤버" && row["value"] == "김 인턴"));
    }

    #[test]
    fn a_member_is_named_by_display_name_handle_and_kind() {
        assert_eq!(
            member_card_label("김 인턴", "intern", false),
            "김 인턴 (@intern)"
        );
        assert_eq!(
            member_card_label("김 인턴", "intern2", true),
            "김 인턴 (@intern2, 에이전트)"
        );
    }

    #[test]
    fn the_channel_result_line_carries_the_id_and_no_link() {
        let id = Uuid::from_u128(0xabc);
        let body = channel_create_result_body("계획", "private", id);
        assert!(body.contains(&id.to_string()), "{body}");
        assert!(!body.contains("http"));
    }

    #[test]
    fn the_request_body_is_readable_without_props() {
        let action = action_by_id(ACTION_INVITE_CREATE).expect("v1");
        assert_eq!(
            workspace_action_request_body(action),
            "팀원 초대 링크를 만들어도 될까요?"
        );
    }

    // -- 부록 B / D4 -------------------------------------------------------

    fn executed_result() -> Value {
        action_result_props(&ActionResult {
            action_id: ACTION_INVITE_CREATE,
            status: ACTION_RESULT_EXECUTED,
            approval_id: Uuid::from_u128(11),
            decided_by: Uuid::from_u128(12),
            ref_type: REF_TYPE_INVITE,
            ref_id: Uuid::from_u128(13),
            rows: invite_result_rows("member", "2026-09-29"),
            secret_shown_once: true,
            expression: None,
            next: Some(INVITE_RESULT_NEXT),
        })
    }

    /// 부록 B, key by key — and **closed**. The point of spelling the whole key
    /// set is the negative half: adding `code`, `url`, `link` or `invite_code`
    /// to the builder fails here, which is the mutation ADR-0186 D4 is about.
    #[test]
    fn the_result_props_are_appendix_b_and_the_key_set_is_closed() {
        let props = executed_result();
        let card = &props[ACTION_RESULT_PROPS_KEY];
        let mut keys: Vec<&str> = card
            .as_object()
            .expect("the result card is an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "action_id",
                "approval_id",
                "decided_by",
                "next",
                "ref",
                "rows",
                "secret_shown_once",
                "status",
                "v",
            ],
            "부록 B is a closed object; a new key is a new durable field"
        );
        assert_eq!(card["v"], json!(1));
        assert_eq!(card["action_id"], json!("invite.create"));
        assert_eq!(card["status"], json!("executed"));
        assert_eq!(card["approval_id"], json!(Uuid::from_u128(11).to_string()));
        assert_eq!(card["decided_by"], json!(Uuid::from_u128(12).to_string()));
        assert_eq!(
            card["ref"],
            json!({"type": "invite", "id": Uuid::from_u128(13).to_string()})
        );
        assert_eq!(
            card["rows"],
            json!([
                {"label": "역할", "value": "member"},
                {"label": "만료", "value": "2026-09-29"}
            ])
        );
        // A flag, not a value.
        assert_eq!(card["secret_shown_once"], json!(true));
        assert!(card["secret_shown_once"].is_boolean());
        // The `ref` the response carries and the one the card carries are one
        // builder, so a client can match them without knowing two spellings.
        assert_eq!(
            card["ref"],
            action_ref(REF_TYPE_INVITE, Uuid::from_u128(13))
        );
    }

    /// The one-time value has nowhere to live in this object — measured as
    /// absence of the fields **and** absence of the shapes.
    #[test]
    fn no_field_of_the_result_card_can_carry_a_code_or_a_url() {
        let props = executed_result();
        let card = &props[ACTION_RESULT_PROPS_KEY];
        for forbidden in [
            "code",
            "invite_code",
            "url",
            "link",
            "join_url",
            "secret",
            "secret_once",
            "value",
            "href",
        ] {
            assert!(
                card.get(forbidden).is_none(),
                "{forbidden} must not be a result-card field"
            );
        }
        // …and the only `href` anywhere under it is the fixed in-app path.
        assert_eq!(card["next"]["href"], json!("/settings?section=members"));
        assert_eq!(card["next"]["label"], json!("설정 › 멤버와 초대에서 보기"));
        let rendered = props.to_string();
        assert!(!rendered.contains("http"), "{rendered}");
        assert!(!rendered.contains("code="), "{rendered}");
        assert!(
            !rendered.contains("?code"),
            "the href must not be able to carry a query the way a join link does: {rendered}"
        );
    }

    /// The three messages one approval can author must hold three distinct
    /// idempotency keys, or the spine drops one of them.
    #[test]
    fn the_three_message_keys_of_one_approval_are_distinct_and_stable() {
        let approval = Uuid::from_u128(0x5eed);
        let card = card_client_msg_id(approval);
        let result = result_client_msg_id(approval);
        assert_ne!(card, result);
        assert_ne!(card, approval, "the card is not keyed on the approval");
        assert_ne!(
            result, approval,
            "neither is the result — the rejection/expiry line already holds \
             that key (routes::approvals::reject_run, approval_sweep)"
        );
        // Deterministic: a retried transaction posts one line, not two.
        assert_eq!(result, result_client_msg_id(approval));
        // …and a different approval gets a different key.
        assert_ne!(result, result_client_msg_id(Uuid::from_u128(0x5eee)));
    }

    #[test]
    fn the_result_body_names_the_bounds_and_never_the_link() {
        let body = invite_result_body("member", 1, 7);
        assert_eq!(body, "초대 링크를 만들었어요(member · 1회 · 7일)");
        assert!(!body.contains("http"));
        assert!(!body.contains("code"));
        assert_eq!(
            invite_result_body("admin", 5, 30),
            "초대 링크를 만들었어요(admin · 5회 · 30일)"
        );
    }

    /// The refusal patch sets one word and nothing else; clearing it is a
    /// **removal**, which this builder deliberately cannot express.
    #[test]
    fn the_last_attempt_patch_sets_one_key_and_cannot_null_it() {
        assert_eq!(
            last_attempt_patch(ROLE_REQUIRED),
            json!({"last_attempt": "role_required"})
        );
        assert_eq!(
            last_attempt_patch(ROLE_REQUIRED)
                .as_object()
                .expect("object")
                .len(),
            1
        );
    }

    /// **The gate reads what the card published** (ADR-0186 부록 A).
    ///
    /// The approval card advertises `action.required_role` and the decision
    /// route judges the approver against the registry's `RequiredRole`. If
    /// those two ever came from different places, a card could say 「관리자가
    /// 승인해야 합니다」 while the server let somebody else through — or the
    /// reverse. They are one field, and this is the test that says so for every
    /// action the registry carries.
    #[test]
    fn the_card_publishes_exactly_the_role_the_gate_will_require() {
        let expires_at =
            chrono::DateTime::from_timestamp_millis(1_700_000_000_000).expect("an instant");
        for action in ACTIONS {
            let props = workspace_action_request_props(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                Uuid::from_u128(3),
                action,
                action_block(action, vec![], None),
                expires_at,
            );
            assert_eq!(
                props["action"]["required_role"],
                json!(action.required_role.as_wire()),
                "{} publishes a role the gate does not read",
                action.id
            );
            // A role must reach the decision route's `match`
            // (routes::approvals) before it reaches a registry entry — the
            // match is exhaustive so adding a variant fails to compile there.
            assert!(
                RequiredRole::ALL.contains(&action.required_role),
                "{}",
                action.id
            );
        }
    }

    /// The wire vocabulary and the Korean noun of every role: distinct wire
    /// words (a duplicate would make two gates indistinguishable on the card),
    /// snake_case, and a non-empty noun for the summary sentence.
    #[test]
    fn every_required_role_has_a_distinct_wire_word_and_a_noun() {
        let mut wire: Vec<&str> = RequiredRole::ALL.iter().map(|r| r.as_wire()).collect();
        assert_eq!(
            wire,
            vec![
                "admin",
                "agent_editor",
                "requesting_member",
                "dm_participant",
                "workspace_operator",
                "expression_adder"
            ]
        );
        wire.sort_unstable();
        wire.dedup();
        assert_eq!(wire.len(), RequiredRole::ALL.len());
        for role in RequiredRole::ALL {
            assert!(!role.korean().trim().is_empty(), "{role:?}");
        }
        // The agent-scoped role must say whose owner, or a card would read as
        // 「관리자 권한」 for an action the target's owner can approve.
        assert!(RequiredRole::AgentEditor.korean().contains("소유자"));
    }

    /// A result with no `next` carries no `next` key at all (not a null): a
    /// client reading `"next" in card` must not find a dead link.
    #[test]
    fn a_result_without_a_next_step_omits_the_key() {
        let props = action_result_props(&ActionResult {
            action_id: ACTION_INVITE_CREATE,
            status: ACTION_RESULT_EXECUTED,
            approval_id: Uuid::from_u128(1),
            decided_by: Uuid::from_u128(2),
            ref_type: REF_TYPE_INVITE,
            ref_id: Uuid::from_u128(3),
            rows: vec![],
            secret_shown_once: false,
            expression: None,
            next: None,
        });
        assert!(props[ACTION_RESULT_PROPS_KEY].get("next").is_none());
    }

    // ---- ADR-0186 증보 v3 P0: secret delivery foundation -----------------------

    #[test]
    fn exactly_two_actions_hand_a_secret_to_the_agent_and_each_says_how() {
        // Adding a delivering action means a claim kind, a card row and a test in
        // the same commit; this list is where that is noticed.
        let delivering: Vec<(&str, SecretDelivery)> = ACTIONS
            .iter()
            .filter(|action| action.secret_delivery != SecretDelivery::None)
            .map(|action| (action.id, action.secret_delivery))
            .collect();
        assert_eq!(
            delivering,
            vec![
                (ACTION_INVITE_CREATE, SecretDelivery::Always),
                (ACTION_AGENT_INVITE, SecretDelivery::OptIn)
            ]
        );
    }

    #[test]
    fn secret_delivery_wire_values_are_distinct() {
        let mut wire = vec![
            SecretDelivery::None.as_wire(),
            SecretDelivery::OptIn.as_wire(),
            SecretDelivery::Always.as_wire(),
        ];
        wire.sort_unstable();
        wire.dedup();
        assert_eq!(wire.len(), 3);
    }

    #[test]
    fn a_claim_is_single_use_and_ends_at_the_deadline() {
        let decided = 1_000_000;
        let granted = serde_json::json!({ SECRET_CLAIM_PAYLOAD_KEY: secret_claim_grant(decided) });
        assert_eq!(
            secret_claim_state(&granted, decided),
            SecretClaimState::Open
        );
        assert_eq!(
            secret_claim_state(&granted, decided + SECRET_CLAIM_WINDOW_MS),
            SecretClaimState::Open,
            "the deadline itself is still inside the window"
        );
        assert_eq!(
            secret_claim_state(&granted, decided + SECRET_CLAIM_WINDOW_MS + 1),
            SecretClaimState::Expired
        );
        let mut claimed = granted.clone();
        claimed[SECRET_CLAIM_PAYLOAD_KEY]["claimedAtMs"] = serde_json::json!(decided + 5);
        assert_eq!(
            secret_claim_state(&claimed, decided + 6),
            SecretClaimState::AlreadyClaimed
        );
        // A consumed claim stays consumed after the deadline: the answer is not
        // allowed to flip to `Expired`, which would let a client retry as if
        // the value had never been given.
        assert_eq!(
            secret_claim_state(&claimed, decided + SECRET_CLAIM_WINDOW_MS + 99),
            SecretClaimState::AlreadyClaimed
        );
    }

    #[test]
    fn an_approval_without_a_grant_cannot_be_claimed() {
        assert_eq!(
            secret_claim_state(&serde_json::json!({}), 0),
            SecretClaimState::NotGranted
        );
        let denied = serde_json::json!({ SECRET_CLAIM_PAYLOAD_KEY: {"allowed": false, "deadlineMs": i64::MAX} });
        assert_eq!(secret_claim_state(&denied, 0), SecretClaimState::NotGranted);
        let no_deadline = serde_json::json!({ SECRET_CLAIM_PAYLOAD_KEY: {"allowed": true} });
        assert_eq!(
            secret_claim_state(&no_deadline, 0),
            SecretClaimState::Expired
        );
    }

    #[test]
    fn the_pending_cap_is_the_only_flood_control_and_there_is_no_rate_limiter() {
        // 성재 결재 4 (ADR-0186 증보 v3 V3-6): no hourly cap. The registry must
        // not grow a rate-limit field and the v2 pending cap stays 3.
        assert_eq!(MAX_PENDING_WORKSPACE_ACTIONS, 3);
    }

    #[test]
    fn a_claim_judgement_fails_closed_on_every_malformed_marker() {
        // Pinned so a later `unwrap_or`/`as_f64` refactor cannot loosen it
        // (security review of #3795).
        let key = SECRET_CLAIM_PAYLOAD_KEY;
        let state = |claim: serde_json::Value, now: i64| {
            secret_claim_state(&serde_json::json!({ key: claim }), now)
        };
        // Wrong shapes of the whole marker.
        assert_eq!(
            state(serde_json::json!("yes"), 0),
            SecretClaimState::NotGranted
        );
        assert_eq!(
            state(serde_json::json!([]), 0),
            SecretClaimState::NotGranted
        );
        assert_eq!(
            secret_claim_state(&serde_json::json!("not an object"), 0),
            SecretClaimState::NotGranted
        );
        // `allowed` must be the boolean true.
        for allowed in [
            serde_json::json!("true"),
            serde_json::json!(1),
            serde_json::json!(null),
        ] {
            assert_eq!(
                state(
                    serde_json::json!({"allowed": allowed, "deadlineMs": i64::MAX}),
                    0
                ),
                SecretClaimState::NotGranted
            );
        }
        // Deadline must be an i64: a float, a string, a u64 above i64::MAX and a
        // missing one are all Expired, never Open.
        for deadline in [
            serde_json::json!(1.0e15),
            serde_json::json!("9999999999999"),
            serde_json::json!(u64::MAX),
            serde_json::json!(null),
        ] {
            assert_eq!(
                state(
                    serde_json::json!({"allowed": true, "deadlineMs": deadline}),
                    0
                ),
                SecretClaimState::Expired,
                "{deadline}"
            );
        }
        // A null `claimedAtMs` is not a claim; any other present value is, even a
        // falsy one.
        assert_eq!(
            state(
                serde_json::json!({"allowed": true, "deadlineMs": 10, "claimedAtMs": null}),
                5
            ),
            SecretClaimState::Open
        );
        for claimed in [
            serde_json::json!(0),
            serde_json::json!(false),
            serde_json::json!(""),
        ] {
            assert_eq!(
                state(
                    serde_json::json!({"allowed": true, "deadlineMs": 10, "claimedAtMs": claimed}),
                    5
                ),
                SecretClaimState::AlreadyClaimed,
                "{claimed}"
            );
        }
        // Negative `now` is simply earlier than the deadline.
        assert_eq!(
            state(serde_json::json!({"allowed": true, "deadlineMs": 10}), -5),
            SecretClaimState::Open
        );
        // The grant saturates instead of wrapping into the past.
        let near_max = secret_claim_grant(i64::MAX - 1);
        assert_eq!(near_max["deadlineMs"], serde_json::json!(i64::MAX));
    }

    /// ADR-0204 D7: the open list is the actions that mint a value shown once.
    /// Every id on it is a registered action (a typo would open nothing, silently),
    /// and every action that hands a secret to the proposing agent is on it — so a
    /// new secret-minting action cannot ship deciding from the lock screen.
    #[test]
    fn the_open_list_names_registered_actions_and_covers_every_secret_delivery() {
        for id in ONE_TIME_SECRET_ACTION_IDS {
            assert!(
                action_by_id(id).is_some(),
                "{id} is not a registered action"
            );
        }
        for action in ACTIONS {
            if action.secret_delivery != SecretDelivery::None {
                assert!(
                    ONE_TIME_SECRET_ACTION_IDS.contains(&action.id),
                    "{} delivers a one-time secret but is not on the open list",
                    action.id
                );
            }
        }
        assert_eq!(
            ONE_TIME_SECRET_ACTION_IDS,
            [ACTION_INVITE_CREATE, ACTION_AGENT_INVITE]
        );
    }

    #[test]
    fn a_secret_minting_action_opens_in_the_app_and_an_ordinary_one_does_not() {
        let card = |id: &str| serde_json::json!({"action": {"id": id, "args": {}}});
        for id in ONE_TIME_SECRET_ACTION_IDS {
            assert!(
                opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &card(id)),
                "{id}"
            );
        }
        for action in ACTIONS {
            // Pictures, name changes and the two pin actions require the app's full
            // preview: they open for those reasons (pinned by
            // `a_member_avatar_card_always_opens_in_the_app` and
            // `a_pin_card_always_opens_in_the_app`).
            if !ONE_TIME_SECRET_ACTION_IDS.contains(&action.id)
                && action.id != ACTION_MEMBER_AVATAR_SET
                && action.id != ACTION_MEMBER_DISPLAY_NAME_SET
                && action.id != ACTION_AGENT_RENAME
                && action.id != ACTION_DM_AGENT_ADMIT
                && action.id != ACTION_MESSAGE_PIN
                && action.id != ACTION_MESSAGE_UNPIN
                && action.id != ACTION_EXPRESSION_CREATE
                // An agent asking for more channels is a permission (ADR-0204 증보 6 D6-2);
                // pinned by `a_channel_grant_an_agent_asked_for_is_opened_and_the_one_a_person_called_for_is_not`.
                && action.id != ACTION_HOSTED_CHANNELS_GRANT
                // Opened so the 「공급자로 가는 내용」 line is read (pinned by
                // `the_roles_card_is_always_opened_in_the_app`).
                && action.id != ACTION_TEAM_AI_ROLES_SET
            {
                assert!(
                    !opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &card(action.id)),
                    "{} mints nothing shown once and picks no host",
                    action.id
                );
            }
        }
        // Only a *workspace action* reads the id: a tool call whose payload merely
        // contains an action block is still a tool call.
        let tool_call_with_an_action_block = serde_json::json!({
            "tool_call": {"name": crate::tools::WORK_SESSION_END},
            "action": {"id": ACTION_INVITE_CREATE, "args": {}},
        });
        assert!(!opens_in_app("tool_call", &tool_call_with_an_action_block));
    }

    /// ADR-0204 「무엇인지 모르는 알림에는 버튼이 없다」: a shape this build does not
    /// know is opened, not decided from a banner.
    #[test]
    fn a_shape_this_build_does_not_know_is_never_decided_from_a_banner() {
        let card = |id: &str| serde_json::json!({"action": {"id": id, "args": {}}});
        // A workspace action the registry does not carry — e.g. one a newer server
        // wrote — and one whose payload names no action at all.
        assert!(opens_in_app(
            ACTION_TYPE_WORKSPACE_ACTION,
            &card("no.such.action")
        ));
        assert!(opens_in_app(
            ACTION_TYPE_WORKSPACE_ACTION,
            &serde_json::json!({})
        ));
        // An action type none of today's producers writes.
        assert!(opens_in_app("deploy", &serde_json::json!({})));
        assert!(opens_in_app("", &serde_json::json!({})));
        // A tool call that names no tool — there is nothing to say it is safe to
        // decide from a banner.
        assert!(opens_in_app(
            crate::tools::ACTION_TYPE_TOOL_CALL,
            &serde_json::json!({})
        ));
        assert!(opens_in_app(
            crate::tools::ACTION_TYPE_TOOL_CALL,
            &serde_json::json!({"tool_call": {"name": null}})
        ));
        assert!(opens_in_app(
            crate::tools::ACTION_TYPE_TOOL_CALL,
            &serde_json::json!({"tool_call": {"call_id": "c1"}})
        ));
        // A named tool of the catalog stays decidable from the lock screen. A name outside
        // the catalog is an operator's own tool: not an unknown *shape*, but one whose effect
        // the server cannot say it can undo — it opens too (ADR-0204 증보 6 D6-2).
        assert!(!opens_in_app(
            crate::tools::ACTION_TYPE_TOOL_CALL,
            &serde_json::json!({"tool_call": {"name": crate::tools::WORK_SESSION_END}})
        ));
        assert!(opens_in_app(
            crate::tools::ACTION_TYPE_TOOL_CALL,
            &serde_json::json!({"tool_call": {"name": "x"}})
        ));
        assert!(!opens_in_app(
            ACTION_TYPE_WORKSPACE_ACTION,
            &card(ACTION_CHANNEL_CREATE)
        ));
    }

    /// The lock-screen decision for every registered action, written out — **and why**
    /// (ADR-0204 증보 6 D6-2). The questions each row answers: does approving it show the
    /// approver a value once (an invite link, a pairing code — a banner button has nowhere to
    /// show it)? does it widen who may read or write? can a person judge it from a banner at
    /// all? The table is exhaustive on purpose: an action added to the registry fails here until
    /// someone says which side it is on and for which reason, instead of defaulting to a
    /// lock-screen 승인 that mints something nobody sees. (`SecretDelivery` cannot do this job —
    /// it says whether the *proposing agent* may receive a value, which is a different fact.)
    ///
    /// The reason is not a comment: [`decision_reason`] answers it from the same judgment as
    /// [`decision_mode`], so a row that opens for the wrong reason fails too.
    #[test]
    fn every_registered_action_has_a_recorded_lock_screen_decision() {
        use DecisionMode::{Inline, Open};
        use DecisionReason as Why;
        let recorded: &[(&str, DecisionMode, DecisionReason)] = &[
            // Privacy consent is read in the conversation.
            (ACTION_DM_AGENT_ADMIT, Open, Why::NeedsTheApp),
            (ACTION_INVITE_CREATE, Open, Why::OneTimeValue), // the invite link is shown once
            (ACTION_AGENT_INVITE, Open, Why::OneTimeValue),  // the pairing code is shown once
            (ACTION_CHANNEL_CREATE, Inline, Why::None),
            // Not a 「권한」 (ADR-0204 증보 6 D6-9 결재 3, 「전부 권장으로」): the members are named on
            // the card and the role is fixed to member.
            (ACTION_CHANNEL_MEMBER_ADD, Inline, Why::None),
            (ACTION_AGENT_RENAME, Open, Why::NeedsTheApp),
            // The card an agent **asked** for: the agent may read and write more than before
            // (D6-2). The card the server raised in place is the exception, pinned by
            // `a_channel_grant_an_agent_asked_for_is_opened_and_the_one_a_person_called_for_is_not`.
            (ACTION_HOSTED_CHANNELS_GRANT, Open, Why::Permission),
            (ACTION_WORKSPACE_SETTINGS_UPDATE, Inline, Why::None),
            // Inline for a card with neither `avatar` nor `displayName`; see
            // `a_profile_update_that_changes_the_avatar_or_name_opens_in_the_app`.
            (ACTION_AGENT_PROFILE_UPDATE, Inline, Why::None),
            // A picture on a lock-screen banner cannot be judged: always opened.
            (ACTION_MEMBER_AVATAR_SET, Open, Why::NeedsTheApp),
            (ACTION_MEMBER_DISPLAY_NAME_SET, Open, Why::NeedsTheApp),
            // A message the card only quotes (120 characters of up to thousands): the approver
            // reads it in the app (ADR-0186 증보 v5 U-e, review M4).
            (ACTION_MESSAGE_PIN, Open, Why::NeedsTheApp),
            (ACTION_MESSAGE_UNPIN, Open, Why::NeedsTheApp),
            (ACTION_WORKSPACE_UNFURL_UPDATE, Inline, Why::None),
            (ACTION_WORKSPACE_MEMORY_UPDATE, Inline, Why::None),
            // Not a 「권한」 either (D6-9 결재 3).
            (ACTION_WORKSPACE_WORK_TIER_UPDATE, Inline, Why::None),
            // Installs one official app; "the token is not stored in oort", so there is no
            // value to show the approver once (ADR-0113 P3, ADR-0201 증보 v2 H7) — and it is
            // not a 「권한」 (D6-9 결재 3).
            (ACTION_PLUGIN_INSTALL, Inline, Why::None),
            // Switching the helper's reach: turning `files` or `memory` on is a consent to the
            // 「공급자로 가는 내용」 line on the card, and a lock-screen 승인 would skip reading
            // it. Decided by the id alone — the push projection never reads an argument's value
            // (ADR-0201 증보 v3 B3-T, #4964).
            (ACTION_TEAM_AI_ROLES_SET, Open, Why::NeedsTheApp),
            // The picture is the card, and a banner shows none: always opened in the app
            // (ADR-0186 증보 v8 X8-3; no 승인 button on the lock screen).
            (ACTION_EXPRESSION_CREATE, Open, Why::NeedsTheApp),
        ];
        let registered: std::collections::BTreeSet<&str> =
            ACTIONS.iter().map(|action| action.id).collect();
        let written: std::collections::BTreeSet<&str> =
            recorded.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(
            registered, written,
            "a registered action has no lock-screen decision recorded here (or a row \
             names an action that is gone): decide whether approving it shows the \
             approver a value once or widens what an agent may do, add it to \
             ONE_TIME_SECRET_ACTION_IDS if so, and record the row with its reason"
        );
        let card = |id: &str| serde_json::json!({"action": {"id": id, "args": {}}});
        for (id, mode, reason) in recorded {
            assert_eq!(
                decision_mode(ACTION_TYPE_WORKSPACE_ACTION, &card(id)),
                *mode,
                "{id}"
            );
            assert_eq!(
                decision_reason(ACTION_TYPE_WORKSPACE_ACTION, &card(id)),
                *reason,
                "{id}: recorded reason"
            );
            // A row never opens for no reason, and never gives a reason for staying inline.
            assert_eq!(
                *mode == Inline,
                *reason == Why::None,
                "{id}: an inline row has no reason; an open row has one"
            );
            assert_eq!(
                opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &card(id)),
                *mode == Open,
                "{id}: `opens_in_app` is the same answer"
            );
        }
        // Declared, not executable: not in the registry, so a card that names one reads as a
        // shape this build does not know and opens — and stays open when the action is
        // registered (`member.role.set` is a 권한; the row says so when it is opened).
        for declared in DECLARED_NOT_EXECUTABLE {
            assert_eq!(
                (
                    decision_mode(ACTION_TYPE_WORKSPACE_ACTION, &card(declared.id)),
                    decision_reason(ACTION_TYPE_WORKSPACE_ACTION, &card(declared.id)),
                ),
                (Open, Why::UnknownShape),
                "{}",
                declared.id
            );
        }
    }

    /// ADR-0204 증보 6 D6-2, the first changed row: `hosted.channels.grant` that an agent
    /// **asked** for is a permission (the agent reads and writes more than before) and is
    /// opened in the app. The card the server raised in place — because a person called the
    /// agent in that very channel — is the exception and stays decided from the banner. Only
    /// that one origin earns the exception.
    #[test]
    fn a_channel_grant_an_agent_asked_for_is_opened_and_the_one_a_person_called_for_is_not() {
        let grant = |origin: Option<&str>| {
            let mut payload = serde_json::json!({
                "action": {"id": ACTION_HOSTED_CHANNELS_GRANT, "args": {}}
            });
            if let Some(origin) = origin {
                payload["origin"] = serde_json::json!(origin);
            }
            payload
        };
        let both = |payload: &Value| {
            (
                decision_mode(ACTION_TYPE_WORKSPACE_ACTION, payload),
                decision_reason(ACTION_TYPE_WORKSPACE_ACTION, payload),
            )
        };
        assert_eq!(
            both(&grant(None)),
            (DecisionMode::Open, DecisionReason::Permission)
        );
        assert_eq!(
            both(&grant(Some(
                crate::in_place_grant::APPROVAL_ORIGIN_SERVER_IN_PLACE
            ))),
            (DecisionMode::Inline, DecisionReason::None)
        );
        // No other origin borrows the exception.
        for origin in ["dm_agent_admission", "server", "Server_In_Place", ""] {
            assert_eq!(
                decision_mode(ACTION_TYPE_WORKSPACE_ACTION, &grant(Some(origin))),
                DecisionMode::Open,
                "origin {origin:?}"
            );
        }
        // Raised unasked it is still the stronger reason.
        assert_eq!(
            both(&grant(Some(
                crate::initiative::APPROVAL_ORIGIN_AGENT_INITIATED
            ))),
            (DecisionMode::Open, DecisionReason::Unasked)
        );
        // The in-place origin is about this one action: it does not turn another action's
        // card inline.
        let mut pinned = serde_json::json!({
            "action": {"id": ACTION_MESSAGE_PIN, "args": {}},
            "origin": crate::in_place_grant::APPROVAL_ORIGIN_SERVER_IN_PLACE,
        });
        assert_eq!(
            decision_mode(ACTION_TYPE_WORKSPACE_ACTION, &pinned),
            DecisionMode::Open
        );
        pinned["action"]["id"] = serde_json::json!(ACTION_INVITE_CREATE);
        assert_eq!(
            decision_reason(ACTION_TYPE_WORKSPACE_ACTION, &pinned),
            DecisionReason::OneTimeValue
        );
    }

    /// The card carries the answer the function gives, as the word the clients read; and the
    /// props key is the one name everything reads.
    #[test]
    fn the_card_props_carry_the_decision_modes_own_word() {
        let open = serde_json::json!({"action": {"id": ACTION_MESSAGE_PIN, "args": {}}});
        let inline = serde_json::json!({"action": {"id": ACTION_CHANNEL_CREATE, "args": {}}});
        for (payload, word) in [(&open, "open"), (&inline, "inline")] {
            let mut props = serde_json::json!({"approval_id": "a1"});
            stamp_decision_mode(
                &mut props,
                decision_mode(ACTION_TYPE_WORKSPACE_ACTION, payload),
            );
            assert_eq!(props[DECISION_MODE_PROPS_KEY], word);
            assert_eq!(props["approval_id"], "a1", "the other keys are untouched");
        }
        assert_eq!(DECISION_MODE_PROPS_KEY, "decision_mode");
        assert_eq!(DecisionMode::Open.as_str(), "open");
        assert_eq!(DecisionMode::Inline.as_str(), "inline");
        // A card nobody can read stays unread rather than becoming an object.
        let mut not_an_object = serde_json::json!("props");
        stamp_decision_mode(
            &mut not_an_object,
            decision_mode(ACTION_TYPE_WORKSPACE_ACTION, &open),
        );
        assert_eq!(not_an_object, serde_json::json!("props"));
    }

    /// ADR-0186 증보 v4: a `member.avatar.set` card is a picture, so its push never
    /// carries the lock-screen 승인 — whatever the payload looks like.
    #[test]
    fn a_member_avatar_card_always_opens_in_the_app() {
        for payload in [
            serde_json::json!({"action": {"id": ACTION_MEMBER_AVATAR_SET, "args": {}}}),
            serde_json::json!({"action": {"id": ACTION_MEMBER_AVATAR_SET}}),
            serde_json::json!({"action": {"id": ACTION_MEMBER_AVATAR_SET, "args": {
                "avatar": {"source": "staged"}}}}),
        ] {
            assert!(
                opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &payload),
                "{payload}"
            );
        }
    }

    /// ADR-0186 증보 v5 U-e: a pin card quotes a message, so its push never carries the
    /// lock-screen 승인 — whatever else the payload says.
    #[test]
    fn a_pin_card_always_opens_in_the_app() {
        for id in [ACTION_MESSAGE_PIN, ACTION_MESSAGE_UNPIN] {
            for payload in [
                serde_json::json!({"action": {"id": id, "args": {}}}),
                serde_json::json!({"action": {"id": id}}),
                serde_json::json!({"action": {"id": id, "args": {"messageId": "x"}}}),
            ] {
                assert!(
                    opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &payload),
                    "{id}: {payload}"
                );
            }
        }
    }

    /// The registry's contract for the two pin actions: any hosted agent may propose, an
    /// admin decides (no new role), nothing is minted, the helper cannot raise them — and the
    /// arguments are **one id**: no channel, no URL, no text can be spelled at all.
    #[test]
    fn the_pin_actions_take_one_message_id_and_an_admin_decides() {
        for id in [ACTION_MESSAGE_PIN, ACTION_MESSAGE_UNPIN] {
            let action = action_by_id(id).expect("registered");
            assert_eq!(action.required_role, RequiredRole::Admin, "{id}");
            assert_eq!(action.proposers, Proposers::Any, "{id}");
            assert_eq!(action.secret_delivery, SecretDelivery::None, "{id}");
            assert_eq!(action.risk, Risk::Approval, "{id}");
            assert!(proposable_action_by_id(id, ProposalDoor::AgentPort).is_some());
            assert!(
                !TEAM_AI_ACTION_IDS.contains(&id),
                "{id}: the helper's list is closed"
            );
            let schema = action.args_schema();
            assert_eq!(schema["additionalProperties"], serde_json::json!(false));
            assert_eq!(schema["required"], serde_json::json!(["messageId"]));
            let keys: Vec<&String> = schema["properties"]
                .as_object()
                .expect("properties")
                .keys()
                .collect();
            assert_eq!(keys, ["messageId"], "{id}");
            assert!(proposal_summary(action).contains("관리자"), "{id}");
        }
    }

    /// B4-2: the door is read from the stored approval payload, and only from `via_ai.source`.
    #[test]
    fn the_door_is_the_stored_via_ai_source_and_nothing_else() {
        assert!(raised_by_team_ai(&json!({"via_ai": {"source": "team_ai"}})));
        for payload in [
            json!({}),
            json!({"via_ai": {}}),
            json!({"via_ai": {"source": "team_ai "}}),
            json!({"via_ai": {"source": "agent_port"}}),
            json!({"via_ai": "team_ai"}),
            json!({"via_ai": {"source": ["team_ai"]}}),
            // Things an agent can write into a proposal are not the door.
            json!({"action": {"id": "invite.create", "args": {"source": "team_ai"}}, "source": "team_ai"}),
            json!({"action": {"via_ai": {"source": "team_ai"}}}),
        ] {
            assert!(!raised_by_team_ai(&payload), "{payload}");
        }
    }

    /// B4-2's table, cell by cell: where the one-time value goes, by action, door and the
    /// approver's `deliverSecretToAgent`.
    #[test]
    fn the_secret_route_is_the_b4_2_table() {
        let invite = action_by_id(ACTION_INVITE_CREATE).expect("registered");
        let pairing = action_by_id(ACTION_AGENT_INVITE).expect("registered");
        let channel = action_by_id(ACTION_CHANNEL_CREATE).expect("registered");
        for flag in [false, true] {
            // invite.create: the Agent Port's proposer claims it; the helper's goes to the chat.
            assert_eq!(
                secret_route(invite, false, flag),
                SecretRoute::ProposerClaim
            );
            assert_eq!(secret_route(invite, true, flag), SecretRoute::Conversation);
            // agent.invite: the helper's code is the approver's alone, whatever the flag says.
            assert_eq!(secret_route(pairing, true, flag), SecretRoute::Approver);
            // Nothing else has a route but the approver.
            assert_eq!(secret_route(channel, false, flag), SecretRoute::Approver);
            assert_eq!(secret_route(channel, true, flag), SecretRoute::Approver);
        }
        // The Agent Port's agent.invite honours the approver's choice, as before.
        assert_eq!(
            secret_route(pairing, false, true),
            SecretRoute::ProposerClaim
        );
        assert_eq!(secret_route(pairing, false, false), SecretRoute::Approver);
        // Only the Agent Port's agent.invite has a box to tick.
        assert!(offers_opt_in_delivery(pairing, false));
        assert!(!offers_opt_in_delivery(pairing, true));
        assert!(!offers_opt_in_delivery(invite, false));
        assert!(!offers_opt_in_delivery(invite, true));
        assert!(!offers_opt_in_delivery(channel, false));
    }

    /// B4-2's card rows, from the helper's door only: the Agent Port's sentence is replaced, not
    /// added to, and every other row keeps its place.
    #[test]
    fn the_helper_door_swaps_the_delivery_row_and_only_that_row() {
        let invite_rows = invite_create_rows("member", 5, Some(7));
        let swapped = team_ai_door_rows(ACTION_INVITE_CREATE, invite_rows.clone());
        assert_eq!(swapped.len(), invite_rows.len());
        assert_eq!(swapped[..3], invite_rows[..3]);
        assert_eq!(
            swapped[3],
            json!({
                "label": "링크 받는 곳",
                "value": "승인하면 도우미가 이 대화에 링크를 올려요. 대화에 있는 사람은 모두 볼 수 있어요"
            })
        );
        assert!(!swapped
            .iter()
            .any(|row| row["value"] == INVITE_DELIVERY_TEXT));

        let pairing_rows = agent_invite_rows("Grok Bot", "그록봇", "grokbot");
        let swapped = team_ai_door_rows(ACTION_AGENT_INVITE, pairing_rows.clone());
        assert_eq!(swapped.len(), pairing_rows.len());
        assert_eq!(swapped[1..], pairing_rows[1..]);
        assert_eq!(
            swapped[0],
            json!({"label": "연결 코드 받는 사람", "value": "승인한 분만 한 번 볼 수 있어요"})
        );
        // An action with no delivery row is untouched, and a row set that lost the label still says it.
        let other = vec![action_row("채널", "#a")];
        assert_eq!(
            team_ai_door_rows(ACTION_CHANNEL_CREATE, other.clone()),
            other
        );
        let lost = team_ai_door_rows(ACTION_INVITE_CREATE, vec![action_row("역할", "member")]);
        assert_eq!(lost.len(), 2);
        assert_eq!(lost[1]["label"], "링크 받는 곳");
    }

    /// B4-7: the helper card's audit provenance is names, counts and numbers — and an invented
    /// field, a long string or a non-string in `tools` does not ride along.
    #[test]
    fn the_audit_provenance_is_text_free_and_only_for_the_helpers_invite_cards() {
        let payload = json!({
            "via_ai": {
                "source": "team_ai", "requester_id": "u", "trigger_message_id": "m",
                "model": "claude-x", "latency_ms": 812, "prompt_tokens": 120,
                "completion_tokens": 40, "tools": ["read_channel"], "model_calls": 2,
                "web_searches": 0, "note": "무엇이든 쓴 글", "rationale": "무엇이든 쓴 글"
            }
        });
        let via = team_ai_audit_via(&payload).expect("a helper card");
        assert_eq!(
            via,
            json!({"source": "team_ai", "model": "claude-x", "latency_ms": 812,
                   "prompt_tokens": 120, "completion_tokens": 40, "model_calls": 2,
                   "web_searches": 0, "tools": ["read_channel"]})
        );
        let tampered = json!({"via_ai": {"source": "team_ai", "model": "m".repeat(200),
            "latency_ms": "빠름", "tools": ["x".repeat(300)], "model_calls": 1.5}});
        assert_eq!(
            team_ai_audit_via(&tampered),
            Some(json!({"source": "team_ai"}))
        );
        assert_eq!(team_ai_audit_via(&json!({})), None);
        assert_eq!(
            team_ai_audit_via(&json!({"via_ai": {"source": "other"}})),
            None
        );

        let detail = json!({"role": "member"});
        for id in [ACTION_INVITE_CREATE, ACTION_AGENT_INVITE] {
            assert_eq!(
                with_team_ai_audit_via(id, &payload, detail.clone())["via_ai"]["tools"],
                json!(["read_channel"]),
                "{id}"
            );
            assert_eq!(
                with_team_ai_audit_via(id, &json!({}), detail.clone()),
                detail,
                "{id}"
            );
        }
        // Another action's rows are left alone: this slice does not widen the audit shape.
        assert_eq!(
            with_team_ai_audit_via(ACTION_CHANNEL_CREATE, &payload, detail.clone()),
            detail
        );
    }

    /// The link message's idempotency key is its own: not the card's, not the result line's.
    #[test]
    fn the_invite_link_message_has_its_own_client_msg_id() {
        let approval = Uuid::new_v4();
        let ids = [
            invite_link_client_msg_id(approval),
            card_client_msg_id(approval),
            result_client_msg_id(approval),
        ];
        assert_ne!(ids[0], ids[1]);
        assert_ne!(ids[0], ids[2]);
        assert_ne!(ids[1], ids[2]);
        assert_eq!(invite_link_client_msg_id(approval), ids[0]);
        assert_ne!(invite_link_client_msg_id(Uuid::new_v4()), ids[0]);
    }

    fn pin_message(body: &str) -> PinCardMessage {
        let (excerpt, total, truncated) = pin_card_excerpt(body);
        PinCardMessage {
            channel_name: "design".to_string(),
            channel_kind: "private".to_string(),
            author_label: member_card_label("이도현", "dohyun", false),
            created_at: chrono::DateTime::from_timestamp(1_700_000_000, 0).expect("epoch"),
            excerpt,
            total_chars: (!body.is_empty()).then_some(total as i64),
            truncated,
            attachment_count: 0,
            pinned_count: 3,
            pinned_by_label: Some(member_card_label("박서연", "seoyeon", false)),
            pinned_at: chrono::DateTime::from_timestamp(1_700_003_600, 0),
        }
    }

    /// The quote on a pin card is one plain line: a message cannot draw a second row, a fake
    /// button line or reversed text there, and the length it reports is the message's own.
    #[test]
    fn a_pin_card_quotes_one_plain_line_and_reports_the_real_length() {
        let (excerpt, total, truncated) =
            pin_card_excerpt("첫 줄\n\t둘째  줄\r\n\u{202E}거꾸로\u{200B}");
        assert_eq!(excerpt, "첫 줄 둘째 줄 거꾸로");
        assert_eq!(
            total,
            "첫 줄\n\t둘째  줄\r\n\u{202E}거꾸로\u{200B}"
                .chars()
                .count()
        );
        assert!(!truncated);

        // Exactly at the limit is whole; one more is cut and says so.
        let exact = "가".repeat(PIN_CARD_EXCERPT_CHARS);
        assert_eq!(pin_card_excerpt(&exact), (exact.clone(), 120, false));
        let longer = "가".repeat(PIN_CARD_EXCERPT_CHARS + 1);
        let (excerpt, total, truncated) = pin_card_excerpt(&longer);
        assert_eq!(total, 121, "the length is the message's, not the quote's");
        assert!(truncated);
        assert_eq!(excerpt, format!("{}…", "가".repeat(PIN_CARD_EXCERPT_CHARS)));
    }

    /// 「총 글자 수를 함께 싣고 앱에서 전문을 볼 수 있게」 (review M4): a long message's card
    /// carries its real length, a row that sends the approver to the app, and a preview with the
    /// ids a client needs to open it; a short one carries no such row.
    #[test]
    fn a_long_message_card_says_how_long_it_is_and_where_to_read_it_whole() {
        let long = pin_message(&"가".repeat(5_000));
        let rows = message_pin_rows(false, &long);
        let row = |label: &str| {
            rows.iter()
                .find(|row| row["label"] == label)
                .map(|row| row["value"].as_str().expect("text").to_string())
        };
        assert_eq!(row("글자 수").as_deref(), Some("5000자"));
        assert!(row("전문").is_some_and(|text| text.contains("앱")));
        assert_eq!(row("지금 고정된 수").as_deref(), Some("3/100"));
        assert_eq!(row("공개 범위").as_deref(), Some("비공개"));
        assert!(
            row("고정한 사람").is_none(),
            "only an unpin card says who pinned"
        );
        let preview = message_pin_preview(Uuid::from_u128(1), Uuid::from_u128(2), &long);
        assert_eq!(preview["totalChars"], serde_json::json!(5000));
        assert_eq!(preview["truncated"], serde_json::json!(true));
        assert_eq!(
            preview["messageId"],
            serde_json::json!(Uuid::from_u128(1).to_string())
        );

        let short = pin_message("안녕하세요");
        let rows = message_pin_rows(false, &short);
        assert!(rows.iter().all(|row| row["label"] != "전문"));

        // An unpin card also says who pinned it, and when.
        let rows = message_pin_rows(true, &short);
        assert!(rows.iter().any(|row| row["label"] == "고정한 사람"));
        assert!(rows.iter().any(|row| row["label"] == "고정한 시각"));
    }

    /// The registry's contract for `member.avatar.set`: only the person it changes may
    /// approve, any hosted agent may propose, nothing is minted — and the arguments name
    /// **no target**. The one key is the attachment; a `memberId`, a `targetHandle`, a URL
    /// or a data field cannot be spelled at all (`additionalProperties: false`), which is
    /// ADR-0201 증보 v3 B3-T (#4964): the roles card is a helper-only, admin-decided, secret-free
    /// card whose arguments are exactly one bundle and one switch, and it is always opened in the
    /// app whatever the arguments say (the push projection never reads a value).
    #[test]
    fn the_roles_card_is_always_opened_in_the_app() {
        let action = action_by_id(ACTION_TEAM_AI_ROLES_SET).expect("registered");
        assert_eq!(action.required_role, RequiredRole::Admin);
        assert_eq!(action.proposers, Proposers::TeamAiOnly);
        assert_eq!(action.secret_delivery, SecretDelivery::None);
        assert_eq!(action.risk, Risk::Approval);
        assert!(!action.initiative, "never raised unasked");
        assert!(proposable_action_by_id(ACTION_TEAM_AI_ROLES_SET, ProposalDoor::TeamAi).is_some());
        assert!(
            proposable_action_by_id(ACTION_TEAM_AI_ROLES_SET, ProposalDoor::AgentPort).is_none(),
            "an external agent cannot raise it"
        );
        assert!(TEAM_AI_ACTION_IDS.contains(&ACTION_TEAM_AI_ROLES_SET));
        assert!(initiative_action_by_id(ACTION_TEAM_AI_ROLES_SET).is_none());
        let schema = action.args_schema();
        assert_eq!(schema["additionalProperties"], serde_json::json!(false));
        assert_eq!(schema["required"], serde_json::json!(["bundle", "enabled"]));
        assert_eq!(
            schema["properties"]["bundle"]["enum"],
            serde_json::json!(crate::team_ai_roles::SWITCHABLE_BUNDLES),
            "the six switchable bundles, and no `chat_read`"
        );
        assert!(proposal_summary(action).contains("관리자"));
        for args in [
            serde_json::json!({"bundle": "files", "enabled": true}),
            serde_json::json!({"bundle": "files", "enabled": false}),
            serde_json::json!({}),
        ] {
            let card =
                serde_json::json!({"action": {"id": ACTION_TEAM_AI_ROLES_SET, "args": args}});
            assert!(opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &card), "{card}");
        }
    }

    /// what keeps "only my own face" a property of the schema and not of a validator.
    #[test]
    fn member_avatar_set_names_a_picture_and_never_a_person() {
        let action = action_by_id(ACTION_MEMBER_AVATAR_SET).expect("registered");
        assert_eq!(action.required_role, RequiredRole::RequestingMember);
        assert_eq!(action.proposers, Proposers::Any);
        assert_eq!(action.secret_delivery, SecretDelivery::None);
        assert_eq!(action.risk, Risk::Approval);
        assert!(
            proposable_action_by_id(ACTION_MEMBER_AVATAR_SET, ProposalDoor::AgentPort).is_some()
        );
        assert!(TEAM_AI_ACTION_IDS.contains(&ACTION_MEMBER_AVATAR_SET));
        let schema = action.args_schema();
        assert_eq!(schema["additionalProperties"], serde_json::json!(false));
        assert_eq!(schema["minProperties"], serde_json::json!(1));
        let keys: Vec<&String> = schema["properties"]
            .as_object()
            .expect("properties")
            .keys()
            .collect();
        assert_eq!(keys, ["attachmentId", "avatar"]);
        // The sentence an approver reads names whose authority it is.
        assert!(proposal_summary(action).contains("요청한 본인"));
    }

    /// Planner decision 2026-10-17: the login handoff is approved with the card in
    /// front of you — which session, why — so its push offers 「열어서 결정」 only.
    #[test]
    fn the_login_handoff_opens_in_the_app_whatever_its_spelling() {
        let call = |name: &str| serde_json::json!({"tool_call": {"name": name}});
        assert_eq!(
            OPEN_IN_APP_TOOL_NAMES,
            [crate::tools::WORK_SESSION_LOGIN_HANDOFF]
        );
        // The tool name is read the way the card's own props read it
        // (`login_handoff_session_id`): trimmed, lower-cased, `-` as `_`.
        for spelling in [
            "work.session.login_handoff",
            "Work.Session.Login_Handoff",
            "  work.session.login-handoff ",
        ] {
            assert!(
                opens_in_app(crate::tools::ACTION_TYPE_TOOL_CALL, &call(spelling)),
                "{spelling:?}"
            );
        }
        // The catalog's tools beside it are decided where they are shown. A name that merely
        // resembles it is outside the catalog, so it opens as an operator's tool does — not
        // because it was mistaken for the handoff (`an_operators_own_tool_is_opened_in_the_app`).
        for name in [
            crate::tools::WORK_SESSION_END,
            crate::tools::WORK_SESSION_SPAWN,
        ] {
            assert!(
                !opens_in_app(crate::tools::ACTION_TYPE_TOOL_CALL, &call(name)),
                "{name:?}"
            );
        }
        for name in ["work.session.login", "work.session.login_handoff.extra"] {
            assert_eq!(
                decision_reason(crate::tools::ACTION_TYPE_TOOL_CALL, &call(name)),
                DecisionReason::Irreversible,
                "{name:?} is an operator's tool, not the handoff"
            );
        }
        // And only as a tool call: the same name on a workspace action reads the id.
        assert!(!opens_in_app(
            ACTION_TYPE_WORKSPACE_ACTION,
            &serde_json::json!({
                "tool_call": {"name": crate::tools::WORK_SESSION_LOGIN_HANDOFF},
                "action": {"id": ACTION_CHANNEL_CREATE, "args": {}},
            })
        ));
    }

    /// A tool the catalog does not carry is an operator's own (`agent.tool_schema`, see
    /// `tools::momo_tool_name`): momo does not own its name and cannot say whether what it does
    /// can be undone, so it is opened in the app and the banner never approves it
    /// (ADR-0204 증보 6 D6-2 · D6-9 결재 1: 「모르면 연다」 — this turns the 2026-10-17 choice to keep
    /// it inline around). A name that merely *resembles* the handoff is such a tool too.
    #[test]
    fn an_operators_own_tool_is_opened_in_the_app() {
        let call = |name: &str| serde_json::json!({"tool_call": {"name": name}});
        for name in [
            "github.search_issues",
            "send_message",
            "work.session.login_handoff_v2",
            "work_session_login_handoff",
            "work.session.login",
        ] {
            assert!(
                !crate::tools::is_executable(name),
                "{name} is in the catalog after all"
            );
            assert_eq!(
                decision_mode(crate::tools::ACTION_TYPE_TOOL_CALL, &call(name)),
                DecisionMode::Open,
                "{name}"
            );
            assert_eq!(
                decision_reason(crate::tools::ACTION_TYPE_TOOL_CALL, &call(name)),
                DecisionReason::Irreversible,
                "{name}"
            );
        }
        // The catalog's own tools keep the default: a tool momo owns is judged by its name.
        for name in [
            crate::tools::WORK_SESSION_END,
            crate::tools::WORK_SESSION_SPAWN,
            crate::tools::CARD_SUGGEST,
            crate::tools::MEMORY_SUGGEST,
            crate::tools::WORKSPACE_ACTION_PROPOSE,
        ] {
            assert_eq!(
                decision_mode(crate::tools::ACTION_TYPE_TOOL_CALL, &call(name)),
                DecisionMode::Inline,
                "{name}"
            );
        }
        // The spelling does not matter: a catalog name is read the way `tools::normalize` reads it.
        assert_eq!(
            decision_mode(
                crate::tools::ACTION_TYPE_TOOL_CALL,
                &call("  Work.Session.End ")
            ),
            DecisionMode::Inline
        );
    }

    /// The tools whose approval IS the human's act (`ApprovalReason::HumanIsTheAction`:
    /// nobody can pre-approve typing somebody else's password) are the ones the lock
    /// screen cannot stand in for. Today that is the login handoff, and it is on the open
    /// list; a tool that joins that class without joining the list fails here.
    #[test]
    fn a_tool_whose_approval_is_the_humans_act_is_opened_in_the_app() {
        let mut found = Vec::new();
        for name in crate::tools::CATALOG {
            if crate::tools::approval_reason(name, None)
                == crate::tools::ApprovalReason::HumanIsTheAction
            {
                found.push(*name);
                assert!(
                    opens_in_app(
                        crate::tools::ACTION_TYPE_TOOL_CALL,
                        &serde_json::json!({"tool_call": {"name": name}})
                    ),
                    "{name} is the human's own act but is not on OPEN_IN_APP_TOOL_NAMES"
                );
            }
        }
        assert_eq!(
            found,
            [crate::tools::WORK_SESSION_LOGIN_HANDOFF],
            "the class of tools whose approval is the human's act changed — decide each one"
        );
    }

    /// Every tool this server can execute has its lock-screen decision written down, and the
    /// reason, like the actions: adding one to the catalog fails here until someone says
    /// whether the lock screen can show what is being approved.
    #[test]
    fn every_catalog_tool_has_a_recorded_lock_screen_decision() {
        use DecisionMode::{Inline, Open};
        use DecisionReason as Why;
        let recorded: &[(&str, DecisionMode, DecisionReason)] = &[
            (crate::tools::WORK_SESSION_END, Inline, Why::None),
            // A spawn opens through the host picker it carries (`offers_host_choice`,
            // see `a_card_that_asks_for_a_host_opens_in_the_app_whatever_its_type`);
            // a spawn call that has no picker is decided where it is shown.
            (crate::tools::WORK_SESSION_SPAWN, Inline, Why::None),
            // planner 2026-10-17: the approval IS the human's act, on the session's own screen.
            (
                crate::tools::WORK_SESSION_LOGIN_HANDOFF,
                Open,
                Why::NeedsTheApp,
            ),
            // These run without a card of their own, or raise a workspace action whose
            // card is classified by that action's id.
            (crate::tools::CARD_SUGGEST, Inline, Why::None),
            (crate::tools::MEMORY_SUGGEST, Inline, Why::None),
            (crate::tools::WORKSPACE_ACTION_PROPOSE, Inline, Why::None),
        ];
        let catalog: std::collections::BTreeSet<&str> =
            crate::tools::CATALOG.iter().copied().collect();
        let written: std::collections::BTreeSet<&str> =
            recorded.iter().map(|(name, _, _)| *name).collect();
        assert_eq!(
            catalog, written,
            "a tool in the catalog has no lock-screen decision recorded here (or a row \
             names a tool that is gone): decide whether the lock screen can show what \
             is being approved, add it to OPEN_IN_APP_TOOL_NAMES if not, and record the row \
             with its reason"
        );
        for (name, mode, reason) in recorded {
            let payload = serde_json::json!({"tool_call": {"name": name}});
            assert_eq!(
                decision_mode(crate::tools::ACTION_TYPE_TOOL_CALL, &payload),
                *mode,
                "{name}"
            );
            assert_eq!(
                decision_reason(crate::tools::ACTION_TYPE_TOOL_CALL, &payload),
                *reason,
                "{name}: recorded reason"
            );
            assert_eq!(*mode == Inline, *reason == Why::None, "{name}");
        }
    }

    /// Planner decision 2026-10-17 / #4810: a picture or name is approved in the app. An
    /// `agent.profile.update` that carries an `avatar` key — preset, attachment, a
    /// staged image, or `null` to remove it — is opened; the same action changing only
    /// words other than its name is not.
    #[test]
    fn a_profile_update_that_changes_the_avatar_or_name_opens_in_the_app() {
        let update = |args: serde_json::Value| serde_json::json!({"action": {"id": ACTION_AGENT_PROFILE_UPDATE, "args": args}});
        let sha = "a".repeat(64);
        for (label, args) in [
            (
                "a staged image",
                serde_json::json!({"avatar": {
                    "source": "staged",
                    "imageId": "11111111-1111-4111-8111-111111111111",
                    "sha256": sha,
                    "origin": "generated",
                }}),
            ),
            (
                "a preset",
                serde_json::json!({"avatar": {"source": "preset", "presetId": "p1"}}),
            ),
            (
                "an attachment",
                serde_json::json!({"avatar": {"source": "attachment", "attachmentId": "a"}}),
            ),
            ("a removal", serde_json::json!({"avatar": null})),
            (
                "words and a picture",
                serde_json::json!({"tagline": "새 소개", "avatar": {"source": "preset", "presetId": "p1"}}),
            ),
            ("a name", serde_json::json!({"displayName": "새 이름"})),
        ] {
            assert!(
                opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &update(args)),
                "{label}"
            );
        }
        for (label, args) in [
            ("words only", serde_json::json!({"tagline": "새 소개"})),
            (
                "a status",
                serde_json::json!({"statusText": "회의 중", "statusEmoji": "📅"}),
            ),
            ("no arguments", serde_json::json!({})),
        ] {
            assert!(
                !opens_in_app(ACTION_TYPE_WORKSPACE_ACTION, &update(args)),
                "{label}"
            );
        }
        // `args` that are not an object name no avatar — and the push judgment's projection
        // agrees (it asks `jsonb_typeof(args) = 'object'` before it looks for the key;
        // Postgres' `jsonb_exists` alone would say yes to `["avatar"]` and to `"avatar"`).
        assert!(!changes_avatar(&update(serde_json::json!("avatar"))));
        assert!(!changes_avatar(&update(serde_json::json!(["avatar"]))));
        assert!(!changes_avatar(&serde_json::json!({})));
        // The key matters on the profile update only — another action carrying one
        // is still decided by its own id.
        assert!(!opens_in_app(
            ACTION_TYPE_WORKSPACE_ACTION,
            &serde_json::json!({"action": {
                "id": ACTION_CHANNEL_CREATE,
                "args": {"avatar": {"source": "preset", "presetId": "p1"}},
            }})
        ));
    }

    #[test]
    fn a_card_that_asks_for_a_host_opens_in_the_app_whatever_its_type() {
        let spawn = serde_json::json!({
            "execution": {"tool": "codex", "host_candidates": [], "default_host_id": null}
        });
        assert!(opens_in_app("work.spawn", &spawn));
        assert!(opens_in_app("tool_call", &spawn));
        // A tool call of the catalog with no picker is decided where it is shown.
        assert!(!opens_in_app(
            "tool_call",
            &serde_json::json!({"tool_call": {"name": crate::tools::WORK_SESSION_END}})
        ));
    }
}
