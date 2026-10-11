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
    /// `routes::shared::require_workspace_operator`'s set: a workspace
    /// owner/admin, or a principal carrying the platform operator scope.
    WorkspaceOperator,
}

impl RequiredRole {
    pub fn as_wire(self) -> &'static str {
        match self {
            RequiredRole::Admin => "admin",
            RequiredRole::AgentEditor => "agent_editor",
            RequiredRole::WorkspaceOperator => "workspace_operator",
        }
    }

    /// The word the summary sentence uses. Kept beside [`Self::as_wire`] so the
    /// wire value and the Korean noun cannot drift into different roles.
    pub fn korean(self) -> &'static str {
        match self {
            RequiredRole::Admin | RequiredRole::WorkspaceOperator => "관리자",
            RequiredRole::AgentEditor => "대상 에이전트의 소유자 또는 관리자",
        }
    }

    /// Every variant, so a test can measure the wire vocabulary against the
    /// OpenAPI enum without a hand-copied list that could omit a new role.
    pub const ALL: [RequiredRole; 3] = [
        RequiredRole::Admin,
        RequiredRole::AgentEditor,
        RequiredRole::WorkspaceOperator,
    ];
}

/// How many `workspace_action` approvals one agent may have `pending` at once
/// (ADR-0186 증보 V1-e). A run parks on each proposal, so ordinary use never
/// reaches it; it exists so a misbehaving agent cannot stack cards by re-calling
/// `oort_action_propose` from several runs.
pub const MAX_PENDING_WORKSPACE_ACTIONS: i64 = 3;

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
    /// What approving this executes, as a verb phrase. Only used to build
    /// [`proposal_summary`]; it lives here so a new action cannot be added
    /// without writing the sentence a person reads before consenting.
    effect: &'static str,
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

/// The complete registry. Order is the catalog's order.
pub const ACTIONS: &[WorkspaceAction] = &[
    WorkspaceAction {
        id: ACTION_INVITE_CREATE,
        title: "팀원 초대 링크 만들기",
        summary: "역할과 사용 횟수, 만료를 정해 초대 링크를 하나 만듭니다.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        effect: "초대 링크를 만듭니다",
        args_schema: invite_create_args_schema,
    },
    WorkspaceAction {
        id: ACTION_CHANNEL_CREATE,
        title: "채널 만들기",
        summary: "이름과 공개 범위를 정해 채널을 하나 만들고, 이 에이전트와 정한 멤버를 넣습니다.",
        risk: Risk::Approval,
        required_role: RequiredRole::Admin,
        effect: "채널을 만들고, 표시된 대로 이 에이전트와 멤버를 그 채널에 넣습니다",
        args_schema: channel_create_args_schema,
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
        id: "member.role.set",
        title: "멤버 역할 변경",
        summary: "한 멤버의 워크스페이스 역할을 바꿉니다.",
        unavailable_reason: "다음 배치에서 열립니다.",
    },
];

/// The registry's ids, in catalog order. The propose schema's enum and the
/// OpenAPI enum are measured against exactly this.
pub fn action_ids() -> Vec<&'static str> {
    ACTIONS.iter().map(|action| action.id).collect()
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

/// The one-line body of the `approval_request` message.
///
/// A body rather than props alone, because props are a *rendering* affordance:
/// a client that does not know this card kind still shows the person a sentence
/// (ADR-0186 D5's fallback rule).
pub fn workspace_action_request_body(action: &WorkspaceAction) -> String {
    format!("승인 요청: {}", action.title)
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

/// 부록 B `status` — the one this executor writes.
///
/// The vocabulary is `executed | rejected | expired | role_required`; the other
/// three belong to arms that already have their own outcome line (the
/// rejection's and the sweep's `tool_result`, and the card patch a refused
/// decision leaves), so widening those here would put **two** lines under one
/// card.
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

/// The `client_msg_id` of the `action_result` line an executed action posts.
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
        assert_eq!(action_ids(), vec!["invite.create", "channel.create"]);
        assert_eq!(
            DECLARED_NOT_EXECUTABLE
                .iter()
                .map(|declared| declared.id)
                .collect::<Vec<_>>(),
            vec!["webhook.create", "member.role.set"]
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
            "승인 요청: 팀원 초대 링크 만들기"
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
        assert_eq!(wire, vec!["admin", "agent_editor", "workspace_operator"]);
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
            next: None,
        });
        assert!(props[ACTION_RESULT_PROPS_KEY].get("next").is_none());
    }
}
