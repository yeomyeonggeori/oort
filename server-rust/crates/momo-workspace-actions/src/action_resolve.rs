//! The pure and database-resolved halves of a workspace-action proposal
//! (ADR-0186 D2, ADR-0201 D3): argument normalisation, name resolution against
//! the workspace as it is now, and the role-gate subject.
//!
//! This used to live in `bins/momo-server/src/routes/actions.rs`. It moved here
//! so the Agent Port proposal tool (hosted lane) and the team-AI proposal tool
//! (worker lane, ADR-0201) judge a proposal with **one** implementation. Every
//! rejection is a `400`-class [`ActionRejection`]; the server maps it to its HTTP
//! error, the worker maps it to a tool failure.

use momo_db::{DbError, PgConnection};
use momo_messaging::name_guard::{
    conflicts_with_roster, has_hidden_characters, mention_overlaps_roster, role_label_collides,
    text_repeats_roster_name, validated_agent_proposed_display_name, validated_agent_role_label,
    validated_agent_status_emoji, validated_agent_status_text, validated_agent_tagline, RosterName,
};
use momo_messaging::{
    load_roster_names_in_tx, lock_display_name_namespace_in_tx, normalize_channel_kind,
    normalize_channel_name, normalize_channel_topic, read_agent_card_in_tx, AgentCard, FieldPatch,
    PinAction,
};
use momo_settings::{
    is_valid_handle, merge_workspace_settings, normalized_invite_role, read_workspace_settings,
    validated_expires_at_ms, validated_max_uses,
};
use serde_json::{json, Value};
use uuid::Uuid;

use momo_agent::actions::{
    self, PluginInstallBefore, WorkspaceAction, INVITE_EXPIRES_IN_DAYS_CEILING,
    INVITE_MAX_USES_CEILING, INVITE_PROPOSABLE_ROLES,
};
use momo_auth::{
    active_hosted_connection_in_tx, lock_active_hosted_connection_in_tx,
    MAX_HOSTED_APPROVED_CHANNELS,
};

/// A proposal the domain refused. Always a client-class (400) refusal; it never
/// says which name failed to resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionRejection {
    /// Always `400`: every refusal here is the caller's to fix. Carried so the
    /// HTTP layer maps it without guessing.
    pub status: u16,
    pub message: String,
}

impl ActionRejection {
    pub fn new(message: impl Into<String>) -> Self {
        ActionRejection {
            status: 400,
            message: message.into(),
        }
    }
}

pub type ResolveOutcome<T> = Result<Result<T, ActionRejection>, DbError>;

/// The rejection message of a card whose target the **owner** could not already read
/// (ADR-0186 증보 v5 U-b-4 condition 6). The one resolution failure that is the owner's side of
/// the door rather than the agent's: the producer answers it `Unavailable`, like every other
/// refusal of the door, and the agent's own failures stay `InvalidArguments`.
pub const OWNER_CANNOT_SEE: &str = "owner cannot see the target";

/// Whose eyes a card is drawn for — the one place a resolution rule depends on where the card
/// will stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardAudience {
    /// A card a person asked for: it stands in the run's channel, and everything it names is
    /// judged from the **proposer's** point of view (the rules every action had before v5).
    RunChannel,
    /// A card nobody asked for: it stands in `owner`'s one-to-one direct message, so everything
    /// it names must be something `owner` could already read — a public channel or one `owner`
    /// is a live member of — and a pinned message may be in **any** such channel, not only the
    /// run's (the run's channel is the DM itself). A card must never be the first to tell its
    /// owner that a private room, or what is said in it, exists (ADR-0186 증보 v5 U-b-4 6, U-c).
    Owner(Uuid),
}

/// The checks only an **unasked** card adds on top of the action's own normaliser, run on the
/// proposal and again on the stored arguments at decision time (so a tampered row cannot ask
/// for more than the tool could):
///
/// * `channel.create` is a **private** channel — a public one is the whole workspace's room,
///   and only a person asks for one;
/// * its `topic`, like the card's `rationale`, is the agent's own sentence to a person who did
///   not ask: at most [`momo_agent::initiative::INITIATIVE_FREE_TEXT_MAX_CHARS`] characters
///   under the profile-tagline rules (no controls, links or mentions), and what is stored is the
///   sentence **as those rules normalised it** (review M4).
pub fn initiative_args_checks(validated: &mut ValidatedActionArgs) -> Result<(), ActionRejection> {
    if let ActionArgs::ChannelCreate { kind, topic, .. } = &mut validated.args {
        if *kind != "private" {
            return Err(ActionRejection::new("channel kind is not proposable"));
        }
        if let Some(raw) = topic.as_deref() {
            let plain = validated_agent_tagline(raw)
                .map_err(|_| ActionRejection::new("channel topic is not allowed"))?;
            *topic = Some(plain.clone());
            validated.normalized["topic"] = Value::String(plain);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// argument normalisation — the registry's schema, proved by the domain
// ---------------------------------------------------------------------------

/// A proposal's arguments after the domain has agreed to them.
///
/// `normalized` is what goes into `approval.payload.action.args` and `rows` is
/// what goes onto the card. They are built together, from the same values, for
/// one reason: the person approving must be looking at the numbers the executor
/// will use, not at what the agent typed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedActionArgs {
    pub normalized: Value,
    pub rows: Vec<Value>,
    /// The same values, typed, for the **executor** (ADR-0186 D2, AX-3b).
    ///
    /// The decision route re-runs this whole function over the stored
    /// `payload.action.args` rather than trusting what was written months — or
    /// one compromised propose call — ago. Handing it a typed variant instead of
    /// making it dig `normalized["maxUses"].as_i64()` back out is what keeps the
    /// executor from re-deriving, and re-deciding, anything: the parse happened
    /// here, once, and its result is the only thing the executor can act on.
    pub args: ActionArgs,
    /// A full replacement for the card's summary sentence, when the generic one
    /// would mislead (a rename of *another* agent). `None` = the registry's.
    pub summary: Option<String>,
}

/// One action's arguments, after the domain has agreed to them.
///
/// An enum rather than three fields on [`ValidatedActionArgs`] because the next
/// action's arguments are not an invite's; a struct with `role`/`max_uses` would
/// make every future executor read fields that mean nothing to it, and the
/// compiler would not notice.
// One value per request, built and dropped inside a single call: the size gap
// between `AgentProfileUpdate` (a whole card snapshot) and the small variants costs
// nothing that boxing would save.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionArgs {
    /// `message.pin` / `message.unpin` (ADR-0186 증보 v5 U-e, #4703). `message_id` is the one
    /// argument; `target` is filled by [`resolve_action_in_tx`] with what the server read — the
    /// channel, the author, the words (and a hash of them) — and is the **only** thing the card
    /// and the executor describe the message by.
    MessagePin {
        message_id: Uuid,
        change: PinAction,
        target: Option<ResolvedMessage>,
    },
    /// `member.avatar.set` (ADR-0186 증보 v4, #4385). `avatar` is the proposal's
    /// [`AvatarIntent::Attachment`] and, after the handler stages it, the stored
    /// [`AvatarIntent::Staged`]; `target` is filled by [`resolve_action_in_tx`] from the run
    /// (never from an argument).
    MemberAvatarSet {
        avatar: AvatarIntent,
        target: Option<ResolvedPerson>,
    },
    InviteCreate {
        /// `momo_settings::normalized_invite_role`'s canonical spelling.
        role: &'static str,
        max_uses: i32,
        /// `None` means "the statement's own 7-day default"
        /// (`momo_agent::DEFAULT_INVITE_EXPIRES_IN_DAYS`), which is what the
        /// card's 만료 row already showed.
        expires_in_days: Option<i64>,
    },
    /// `channel.create` (증보 V2/V3). `members` is empty after the pure stage and
    /// filled by [`resolve_action_in_tx`] from `handles`.
    ChannelCreate {
        name: String,
        kind: &'static str,
        topic: Option<String>,
        add_proposer: bool,
        handles: Vec<String>,
        members: Vec<ResolvedMember>,
    },
    /// `channel.member.add` (증보 V2). `channel` and `members` are empty after the
    /// pure stage and filled by [`resolve_action_in_tx`]; `new_members` is the
    /// subset not already live in the channel.
    /// `workspace.settings.update` (증보 V7): two keys only. `before` is filled by
    /// [`resolve_action_in_tx`] and is what the card's 「옛 값」 and the pins hold.
    WorkspaceSettingsUpdate {
        welcome_prompt: SettingPatch,
        role_labels: SettingPatch,
        before: SettingsBefore,
    },
    /// `hosted.channels.grant` (증보 V5). `connection` and `channels` are filled by
    /// [`resolve_action_in_tx`]; `channels` is the subset not yet approved.
    HostedChannelsGrant {
        channel_refs: Vec<String>,
        connection: Option<ResolvedConnection>,
        channels: Vec<ResolvedChannel>,
    },
    /// `agent.rename` (증보 V4/V4-M). `target` is filled by
    /// [`resolve_action_in_tx`]; `None` target handle = the proposer itself.
    AgentRename {
        display_name: String,
        target_handle: Option<String>,
        target: Option<ResolvedAgentTarget>,
    },
    /// `agent.invite` (증보 v3 V3-3). `platform` is the card's preset label key
    /// only; the identity is born at decision time as the **approver's**.
    AgentInvite {
        platform: &'static str,
        display_name: String,
        handle: String,
    },
    ChannelMemberAdd {
        channel_ref: String,
        handles: Vec<String>,
        channel: Option<ResolvedChannel>,
        members: Vec<ResolvedMember>,
        already_in: Vec<Uuid>,
    },
    /// `workspace.unfurl.update` (ADR-0201 증보 v2 H6-1). `before` is the switch as
    /// [`resolve_action_in_tx`] found it (a missing row reads as on, ADR-0170 D4).
    WorkspaceUnfurlUpdate { enabled: bool, before: Option<bool> },
    /// `workspace.memory.update` (H6-1). `enabled` is `Some(false)` or `None` —
    /// a card never turns team memory on. Nothing is resolved: the proposing
    /// worker's role cannot read `mem_*` (migration 101), so the card is drawn
    /// from the arguments alone and the executor reads the switch itself.
    WorkspaceMemoryUpdate {
        enabled: Option<bool>,
        paused: Option<bool>,
    },
    /// `workspace.work_tier.update` (H6-1): the workspace default. `before` is the
    /// stored `(mode, autoTarget)` as [`resolve_action_in_tx`] found it.
    WorkspaceWorkTierUpdate {
        mode: &'static str,
        auto_target: Option<String>,
        before: Option<(String, Option<String>)>,
    },
    /// `plugin.install` (ADR-0201 증보 v2 H7, #3889): one of the official four.
    /// `plugin` is filled by [`resolve_action_in_tx`] — the registry row the card
    /// is drawn from and the decision re-proves.
    PluginInstall {
        plugin_id: &'static str,
        plugin: Option<ResolvedPlugin>,
    },
    /// `agent.profile.update` (증보 v3 V3-2). `target` and `before` are filled by
    /// [`resolve_action_in_tx`]; `None` target handle = the proposer itself.
    AgentProfileUpdate {
        display_name: Option<String>,
        tagline: FieldPatch,
        role_label: FieldPatch,
        status: StatusIntent,
        avatar: AvatarIntent,
        target_handle: Option<String>,
        target: Option<ResolvedAgentTarget>,
        before: Option<AgentCard>,
    },
}

/// The message a pin action names, as the server read it **inside the transaction**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMessage {
    pub id: Uuid,
    pub channel_id: Uuid,
    /// The sha256 (hex) of what the approver read: the body, or — for a message with no text —
    /// the list of its attachment ids. Computed by the database over the stored bytes, so the
    /// card, the pin and the decision's re-read all hash the same thing.
    pub body_sha256: String,
    /// What the card draws; see [`actions::PinCardMessage`].
    pub card: actions::PinCardMessage,
}

/// The registry row a `plugin.install` card is drawn from, read as it is now.
///
/// Everything here is bounded and charset-checked by [`read_installable_plugin_in_tx`]
/// before it can reach a card: the registry is operator-owned, not agent-owned,
/// but a card is a place text becomes a consent, so a value that does not look
/// like what it claims to be is a proposal that did not resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPlugin {
    /// The static name from `PLUGIN_INSTALL_PLUGINS`, never registry text.
    pub label: &'static str,
    pub version: String,
    /// The SQL-computed digest of the manifest as stored. The card shows *this*
    /// manifest's egress, and the pin holds this digest: a manifest that changes
    /// between the card and the decision re-asks instead of being installed
    /// under a disclosure it no longer matches (ADR-0113 D5).
    pub digest: String,
    pub egress_domains: Vec<String>,
    pub before: PluginInstallBefore,
}

/// The person a `member.avatar.set` is about, read from the member row (never from an
/// argument): the human who raised the agent run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPerson {
    pub id: Uuid,
    pub display_name: String,
    pub handle: String,
    /// Whether they wear a picture now (an upload, an approved image or a legacy URL) —
    /// the card says 「현재 사진」 or 「없음」 from this.
    pub had_avatar: bool,
}

/// Where a set of action arguments came from. **A proposal comes from an agent; a
/// stored form comes from this server** (it is what the decision route reads back
/// out of `approval.payload`). The one argument that exists only in the stored
/// form is an avatar `source: "staged"` — an agent that sent it would be naming a
/// staged image it did not stage — so the proposal parser refuses it and the
/// stored parser refuses the two raw-input forms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgsOrigin {
    Proposal,
    Stored,
}

/// What a proposal does to the agent's picture (ADR-0186 증보 v3 V3-2a).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum AvatarIntent {
    #[default]
    Unchanged,
    /// `null`: no avatar at all (no image, no preset).
    Clear,
    /// A server preset id.
    Preset(String),
    /// A workspace image file the proposer can read — proposal only; the handler
    /// stages it and the stored form becomes [`AvatarIntent::Staged`].
    Attachment(Uuid),
    /// Bytes the agent generated — proposal only, same.
    Generated(String),
    /// A staged, server-re-encoded image pinned by its sha256 — the **stored**
    /// form. `origin` is `attachment` or `generated`.
    Staged {
        image_id: Uuid,
        sha256: String,
        origin: String,
    },
}

impl AvatarIntent {
    pub fn is_touched(&self) -> bool {
        !matches!(self, AvatarIntent::Unchanged)
    }

    /// How the card names the new picture (never the agent's own words).
    fn after_label(&self) -> Option<String> {
        match self {
            AvatarIntent::Unchanged | AvatarIntent::Clear => None,
            AvatarIntent::Preset(id) => Some(format!("프리셋 {id}")),
            AvatarIntent::Attachment(_) => Some("새 이미지 (워크스페이스 파일)".to_string()),
            AvatarIntent::Generated(_) => Some("새 이미지 (에이전트가 만든 이미지)".to_string()),
            AvatarIntent::Staged { origin, .. } => Some(if origin == "attachment" {
                "새 이미지 (워크스페이스 파일)".to_string()
            } else {
                "새 이미지 (에이전트가 만든 이미지)".to_string()
            }),
        }
    }
}

/// What a proposal does to the custom status. The expiry is **relative** (hours)
/// and becomes an instant only when the executor runs, like an invite's
/// `expiresInDays`: a status must not start ending while its card waits.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum StatusIntent {
    #[default]
    Unchanged,
    Clear,
    Set {
        emoji: Option<String>,
        text: Option<String>,
        hours: i64,
    },
}

/// What a proposal does to one settings key (ADR-0186 증보 V7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingPatch {
    /// The key is not in the proposal: leave it as it is.
    Unchanged,
    /// `null`: remove the key, back to the default.
    Clear,
    Set(Value),
}

impl SettingPatch {
    pub fn is_touched(&self) -> bool {
        !matches!(self, SettingPatch::Unchanged)
    }

    /// The value as the merge sees it: absent, `null` (delete) or the new value.
    fn as_merge_value(&self) -> Option<Value> {
        match self {
            SettingPatch::Unchanged => None,
            SettingPatch::Clear => Some(Value::Null),
            SettingPatch::Set(value) => Some(value.clone()),
        }
    }
}

/// The values the touched keys held when the proposal was resolved — what the
/// card shows as 「옛 값」. `None` = the key is not set.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SettingsBefore {
    pub welcome_prompt: Option<Value>,
    pub role_labels: Option<Value>,
}

/// The proposer's own live hosted connection, as the server found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConnection {
    pub id: Uuid,
    pub approved_before: usize,
}

/// The agent a rename points at, as the server found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAgentTarget {
    pub id: Uuid,
    pub handle: String,
    pub current_display_name: String,
    /// `agent.owner_human_id` of the target (`None` for an ownerless agent).
    pub owner_member_id: Option<Uuid>,
    /// The target is not the proposer (V4-M).
    pub managed: bool,
}

/// A channel a proposal named, as the server found it. Every field is the
/// server's value; the agent's string is only the lookup key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedChannel {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub member_count: i64,
}

/// A workspace member a proposal named by handle, as the server found them.
/// `display_name` is the server's value and is what the card shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMember {
    pub id: Uuid,
    pub handle: String,
    pub display_name: String,
    /// `member.kind`: `human` or `agent`. An agent seated in a channel reads it,
    /// so the card must say which kind it is putting there.
    pub kind: String,
}

impl ResolvedMember {
    /// What the card shows for this member: the display name (not unique), the
    /// handle (unique) and, for an agent, the word 에이전트 — the approver reads
    /// exactly who is being seated.
    pub fn card_label(&self) -> String {
        actions::member_card_label(&self.display_name, &self.handle, self.kind == "agent")
    }
}

/// Normalise `args` for `action`, refusing anything the registry's published
/// schema or the domain's own validators refuse.
///
/// The `ActionRejection` statuses are the ones `agent_port_tools::failure_of` already
/// maps: a bad argument is a 400 and becomes `ToolFailure::InvalidArguments`,
/// so the hosted caller learns *that* its arguments were wrong and never
/// *which* rule it broke.
pub fn validated_action_args(
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
) -> Result<ValidatedActionArgs, ActionRejection> {
    validated_action_args_from(action, args, now_ms, ArgsOrigin::Proposal)
}

/// [`validated_action_args`] with the origin of the arguments named (see
/// [`ArgsOrigin`]). Only the decision route passes [`ArgsOrigin::Stored`].
pub fn validated_action_args_from(
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
    origin: ArgsOrigin,
) -> Result<ValidatedActionArgs, ActionRejection> {
    match action.id {
        actions::ACTION_INVITE_CREATE => invite_create_args(args, now_ms),
        actions::ACTION_CHANNEL_CREATE => channel_create_args(args),
        actions::ACTION_CHANNEL_MEMBER_ADD => channel_member_add_args(args),
        actions::ACTION_AGENT_RENAME => agent_rename_args(args),
        actions::ACTION_HOSTED_CHANNELS_GRANT => hosted_channels_grant_args(args),
        actions::ACTION_WORKSPACE_SETTINGS_UPDATE => workspace_settings_update_args(args),
        actions::ACTION_AGENT_PROFILE_UPDATE => agent_profile_update_args(args, origin),
        actions::ACTION_MEMBER_AVATAR_SET => member_avatar_set_args(args, origin),
        actions::ACTION_MESSAGE_PIN => message_pin_args(args, PinAction::Pinned),
        actions::ACTION_MESSAGE_UNPIN => message_pin_args(args, PinAction::Unpinned),
        actions::ACTION_AGENT_INVITE => agent_invite_args(args),
        actions::ACTION_WORKSPACE_UNFURL_UPDATE => workspace_unfurl_update_args(args),
        actions::ACTION_WORKSPACE_MEMORY_UPDATE => workspace_memory_update_args(args),
        actions::ACTION_WORKSPACE_WORK_TIER_UPDATE => workspace_work_tier_update_args(args),
        actions::ACTION_PLUGIN_INSTALL => plugin_install_args(args),
        // Fail closed. A registry entry with no normaliser must be an error and
        // not an unvalidated passthrough — `every_action_has_a_normaliser` is
        // what makes this arm unreachable rather than merely unlikely.
        _ => Err(ActionRejection::new("unknown workspace action")),
    }
}

pub fn invite_create_args(
    args: &Value,
    now_ms: i64,
) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    for key in object.keys() {
        if !["role", "maxUses", "expiresInDays"].contains(&key.as_str()) {
            return Err(ActionRejection::new("unknown action argument"));
        }
    }

    // `role` — the registry's narrowing first, then the domain's canonical
    // spelling. Doing it in this order is what keeps `guest` out: the domain
    // validator would happily accept it.
    let role = match object.get("role") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            if !INVITE_PROPOSABLE_ROLES.contains(&raw.as_str()) {
                return Err(ActionRejection::new("role is not proposable"));
            }
            Some(raw.clone())
        }
        Some(_) => return Err(ActionRejection::new("role must be a string")),
    };
    let role = normalized_invite_role(role.as_deref())
        .map_err(|error| ActionRejection::new(error.to_string()))?;

    let max_uses = match bounded_integer(object, "maxUses", 1, INVITE_MAX_USES_CEILING)? {
        Some(value) => Some(
            i32::try_from(value).map_err(|_| ActionRejection::new("maxUses is out of range"))?,
        ),
        None => None,
    };
    let max_uses =
        validated_max_uses(max_uses).map_err(|error| ActionRejection::new(error.to_string()))?;

    // `expiresInDays` is stored **relative**, because the executor runs at
    // decision time and not now: an absolute instant computed here would start
    // expiring while the card waits for someone to read it.
    let expires_in_days =
        bounded_integer(object, "expiresInDays", 1, INVITE_EXPIRES_IN_DAYS_CEILING)?;
    // Prove the relative value resolves to a legal absolute one with the very
    // validator `routes::invites::create` uses, so a proposal cannot carry an
    // expiry the invite route would refuse.
    let expires_at_ms = expires_in_days.map(|days| now_ms + days * 86_400_000);
    validated_expires_at_ms(expires_at_ms, now_ms)
        .map_err(|error| ActionRejection::new(error.to_string()))?;

    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({
            "role": role,
            "maxUses": max_uses,
            "expiresInDays": expires_in_days,
        }),
        rows: actions::invite_create_rows(role, max_uses, expires_in_days),
        args: ActionArgs::InviteCreate {
            role,
            max_uses,
            expires_in_days,
        },
    })
}

/// The keys `channel.create` accepts — the registry's schema, as a list the
/// normaliser can close the object with.
pub const CHANNEL_CREATE_KEYS: [&str; 5] =
    ["name", "kind", "topic", "addProposer", "memberHandles"];

/// Reject any key outside `allowed` — the closed object the schema publishes.
pub fn closed_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), ActionRejection> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(ActionRejection::new("unknown action argument"));
        }
    }
    Ok(())
}

/// One optional string argument; `null` is an omitted value (the tool's
/// nullability contract).
pub fn optional_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<&'a str>, ActionRejection> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(ActionRejection::new("argument must be a string")),
    }
}

/// A member handle as a proposal may spell it: one leading `@` tolerated, then
/// the workspace's own handle rule (2..=32 of `[a-z0-9_-]`, lower case).
pub fn normalized_member_handle(raw: &str) -> Result<String, ActionRejection> {
    let trimmed = raw.trim();
    let handle = trimmed.strip_prefix('@').unwrap_or(trimmed).to_lowercase();
    if is_valid_handle(&handle) {
        Ok(handle)
    } else {
        Err(ActionRejection::new("invalid member handle"))
    }
}

/// `memberHandles`: at most the registry's ceiling, normalised, de-duplicated in
/// first-seen order.
pub fn member_handles_arg(
    object: &serde_json::Map<String, Value>,
    key: &str,
    minimum: usize,
) -> Result<Vec<String>, ActionRejection> {
    let items = match object.get(key) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err(ActionRejection::new("argument must be an array")),
    };
    if items.len() > actions::ACTION_MEMBER_HANDLES_MAX as usize || items.len() < minimum {
        return Err(ActionRejection::new("argument is out of range"));
    }
    let mut handles = Vec::new();
    for item in &items {
        let Value::String(raw) = item else {
            return Err(ActionRejection::new("argument must be a string"));
        };
        let handle = normalized_member_handle(raw)?;
        if !handles.contains(&handle) {
            handles.push(handle);
        }
    }
    Ok(handles)
}

pub fn channel_create_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &CHANNEL_CREATE_KEYS)?;

    let raw_name =
        optional_string(object, "name")?.ok_or_else(|| ActionRejection::new("name is required"))?;
    let name = normalize_channel_name(raw_name)
        .map_err(|invalid| ActionRejection::new(invalid.to_string()))?;
    // Private unless the proposal says otherwise, and `dm` is not a kind here.
    let kind_raw = optional_string(object, "kind")?;
    if let Some(kind) = kind_raw {
        if !actions::CHANNEL_CREATE_KINDS.contains(&kind) {
            return Err(ActionRejection::new("channel kind is not proposable"));
        }
    }
    let kind: &'static str =
        match normalize_channel_kind(kind_raw.unwrap_or(actions::CHANNEL_CREATE_DEFAULT_KIND))
            .map_err(|invalid| ActionRejection::new(invalid.to_string()))?
        {
            momo_messaging::ChannelKind::Public => "public",
            _ => "private",
        };
    let topic = normalize_channel_topic(optional_string(object, "topic")?)
        .map_err(|invalid| ActionRejection::new(invalid.to_string()))?;
    let add_proposer = match object.get("addProposer") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(ActionRejection::new("addProposer must be a boolean")),
    };
    let handles = member_handles_arg(object, "memberHandles", 0)?;

    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({
            "name": name,
            "kind": kind,
            "topic": topic,
            "addProposer": add_proposer,
            "memberHandles": handles,
        }),
        // Placeholder rows: the names are the server's, so the real rows are
        // built by `resolve_action_in_tx` once the handles are looked up.
        rows: actions::channel_create_rows(&name, kind, topic.as_deref(), add_proposer, &handles),
        args: ActionArgs::ChannelCreate {
            name,
            kind,
            topic,
            add_proposer,
            handles,
            members: Vec::new(),
        },
    })
}

pub fn channel_member_add_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &["channel", "memberHandles"])?;
    let raw = optional_string(object, "channel")?
        .ok_or_else(|| ActionRejection::new("channel is required"))?;
    // One leading `#` is tolerated (that is how a card and a mention spell it);
    // the rest is the REST normaliser's, so a name that could never exist is
    // refused here rather than looked up.
    let trimmed = raw.trim();
    let channel_ref = normalize_channel_name(trimmed.strip_prefix('#').unwrap_or(trimmed))
        .map_err(|invalid| ActionRejection::new(invalid.to_string()))?;
    let handles = member_handles_arg(object, "memberHandles", 1)?;
    if object.get("memberHandles").is_none_or(Value::is_null) {
        return Err(ActionRejection::new("memberHandles is required"));
    }
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({"channel": channel_ref, "memberHandles": handles}),
        rows: actions::channel_member_add_rows(&channel_ref, "private", 0, &handles, 0),
        args: ActionArgs::ChannelMemberAdd {
            channel_ref,
            handles,
            channel: None,
            members: Vec::new(),
            already_in: Vec::new(),
        },
    })
}

/// The settings keys as the bag spells them, in the order the card lists them.
pub const SETTINGS_KEYS: [(&str, &str, &str); 2] = [
    ("welcomePrompt", "welcome_prompt", "환영 문구"),
    ("roleLabels", "role_labels", "역할 이름"),
];

pub fn setting_patch(
    object: &serde_json::Map<String, Value>,
    wire_key: &str,
) -> Result<SettingPatch, ActionRejection> {
    match object.get(wire_key) {
        None => Ok(SettingPatch::Unchanged),
        Some(Value::Null) => Ok(SettingPatch::Clear),
        Some(value) => Ok(SettingPatch::Set(value.clone())),
    }
}

pub fn workspace_settings_update_args(
    args: &Value,
) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    // The two keys, by name. `allowedAgentModels`, `welcomeAgentMemberId` and every
    // other key are refused here AND by the settings allow-list below.
    closed_keys(object, &["welcomePrompt", "roleLabels"])?;
    let welcome_prompt = setting_patch(object, "welcomePrompt")?;
    let role_labels = setting_patch(object, "roleLabels")?;
    if !welcome_prompt.is_touched() && !role_labels.is_touched() {
        return Err(ActionRejection::new("at least one setting is required"));
    }
    if let SettingPatch::Set(value) = &welcome_prompt {
        // 500 characters for a proposal (REST: 2000), and not blank — clearing is
        // `null`, never an empty string.
        let Some(text) = value.as_str() else {
            return Err(ActionRejection::new("welcomePrompt must be a string"));
        };
        if text.trim().is_empty()
            || text.chars().count() > actions::WELCOME_PROMPT_PROPOSAL_MAX_CHARS
        {
            return Err(ActionRejection::new("welcomePrompt is out of range"));
        }
    }
    if let SettingPatch::Set(value) = &role_labels {
        // A non-empty object: `{}` would silently wipe every label, and `null` is
        // the way to say that.
        if value.as_object().is_none_or(|map| map.is_empty()) {
            return Err(ActionRejection::new(
                "roleLabels must be a non-empty object",
            ));
        }
    }
    // Nothing hidden in text an agent writes for an approver to read: no control,
    // zero-width or direction-control characters (a prompt may keep `\n`), and no
    // line break inside a role label.
    if let SettingPatch::Set(Value::String(text)) = &welcome_prompt {
        if has_hidden_characters(text, true) {
            return Err(ActionRejection::new("welcomePrompt has hidden characters"));
        }
    }
    if let SettingPatch::Set(Value::Object(labels)) = &role_labels {
        if labels
            .values()
            .filter_map(Value::as_str)
            .any(|label| has_hidden_characters(label, false))
        {
            return Err(ActionRejection::new("a role label has hidden characters"));
        }
    }
    // The REST validators, reused as they are: shape, role keys, label bytes and
    // the settings allow-list. (Run on an empty bag — only validation matters.)
    let mut probe = serde_json::Map::new();
    for (wire, stored, _) in SETTINGS_KEYS {
        let patch = if wire == "welcomePrompt" {
            &welcome_prompt
        } else {
            &role_labels
        };
        if let Some(value) = patch.as_merge_value() {
            probe.insert(stored.to_string(), value);
        }
    }
    merge_workspace_settings(&json!({}), &Value::Object(probe))
        .map_err(|error| ActionRejection::new(error.to_string()))?;

    let mut normalized = serde_json::Map::new();
    for (wire, _, _) in SETTINGS_KEYS {
        let patch = if wire == "welcomePrompt" {
            &welcome_prompt
        } else {
            &role_labels
        };
        if let Some(value) = patch.as_merge_value() {
            normalized.insert(wire.to_string(), value);
        }
    }
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: Value::Object(normalized),
        rows: Vec::new(),
        args: ActionArgs::WorkspaceSettingsUpdate {
            welcome_prompt,
            role_labels,
            before: SettingsBefore::default(),
        },
    })
}

/// How a settings value reads on a card: a string as itself, a role-label object
/// as `owner=대표 · admin=…` in the fixed role order. Plain text.
pub fn settings_display(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(serde_json::to_string(text).unwrap_or_default()),
        Value::Object(map) => Some(
            actions::ROLE_LABEL_PROPOSAL_KEYS
                .iter()
                .filter_map(|role| {
                    map.get(*role).and_then(Value::as_str).map(|label| {
                        format!(
                            "{role}={}",
                            serde_json::to_string(label).unwrap_or_default()
                        )
                    })
                })
                .collect::<Vec<_>>()
                .join(" · "),
        ),
        other => Some(other.to_string()),
    }
}

/// One required/optional boolean argument. `null` is **not** an omission here: a
/// switch an approver reads must be one of two words, never a third.
fn boolean_arg(
    object: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<bool>, ActionRejection> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ActionRejection::new("argument must be a boolean")),
    }
}

/// `workspace.unfurl.update` (ADR-0201 증보 v2 H6-1): `{enabled}`, required — the
/// body `PUT …/unfurl-settings` takes.
pub fn workspace_unfurl_update_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &["enabled"])?;
    let enabled = boolean_arg(object, "enabled")?
        .ok_or_else(|| ActionRejection::new("enabled is required"))?;
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({ "enabled": enabled }),
        rows: Vec::new(),
        args: ActionArgs::WorkspaceUnfurlUpdate {
            enabled,
            before: None,
        },
    })
}

/// `plugin.install` (ADR-0201 증보 v2 H7): `{pluginId}`, required, one of the
/// official four. The id is matched against the static table and the table's own
/// `&'static str` is what is kept, so nothing an agent typed travels further than
/// this comparison — the refusals name no value.
pub fn plugin_install_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &["pluginId"])?;
    let raw = match object.get("pluginId") {
        Some(Value::String(raw)) => raw.as_str(),
        Some(_) => return Err(ActionRejection::new("pluginId must be a string")),
        None => return Err(ActionRejection::new("pluginId is required")),
    };
    let Some((plugin_id, _)) = actions::PLUGIN_INSTALL_PLUGINS
        .iter()
        .find(|(id, _)| *id == raw)
    else {
        return Err(ActionRejection::new("pluginId is not an official plugin"));
    };
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({ "pluginId": plugin_id }),
        rows: Vec::new(),
        args: ActionArgs::PluginInstall {
            plugin_id,
            plugin: None,
        },
    })
}

/// `workspace.memory.update` (H6-1): `{enabled?: false, paused?}`, one at least.
/// `enabled: true` is refused here as well as by the published schema's
/// `const:false` — turning team memory on sends channel text to a provider, and
/// that is an admin's choice in settings after reading the team notice (ADR-0196).
pub fn workspace_memory_update_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &["enabled", "paused"])?;
    let enabled = boolean_arg(object, "enabled")?;
    let paused = boolean_arg(object, "paused")?;
    if enabled == Some(true) {
        return Err(ActionRejection::new(
            "team memory cannot be turned on from a card",
        ));
    }
    if enabled.is_none() && paused.is_none() {
        return Err(ActionRejection::new("enabled or paused is required"));
    }
    let mut normalized = serde_json::Map::new();
    if let Some(enabled) = enabled {
        normalized.insert("enabled".into(), json!(enabled));
    }
    if let Some(paused) = paused {
        normalized.insert("paused".into(), json!(paused));
    }
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: Value::Object(normalized),
        rows: actions::memory_update_rows(enabled, paused),
        args: ActionArgs::WorkspaceMemoryUpdate { enabled, paused },
    })
}

/// `workspace.work_tier.update` (H6-1): `{mode, autoTarget?}`, proved by the REST
/// route's own validators (`validated_tier_mode`, `validated_auto_target` — the
/// cross-field rule included). Whether the target host may serve the workspace is
/// a database question and is asked by the resolver.
pub fn workspace_work_tier_update_args(
    args: &Value,
) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &["mode", "autoTarget"])?;
    let raw_mode = match object.get("mode") {
        Some(Value::String(mode)) => mode.as_str(),
        _ => return Err(ActionRejection::new("mode is required")),
    };
    let mode = momo_settings::validated_tier_mode(raw_mode)
        .map_err(|error| ActionRejection::new(error.to_string()))?;
    let raw_target = optional_string(object, "autoTarget")?;
    if raw_target
        .is_some_and(|target| target.len() as u64 > actions::WORK_TIER_AUTO_TARGET_MAX_BYTES)
    {
        return Err(ActionRejection::new("autoTarget is out of range"));
    }
    let auto_target = momo_settings::validated_auto_target(raw_target, mode)
        .map_err(|error| ActionRejection::new(error.to_string()))?;
    let mut normalized = serde_json::Map::new();
    normalized.insert("mode".into(), json!(mode));
    if let Some(target) = &auto_target {
        normalized.insert("autoTarget".into(), json!(target));
    }
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: Value::Object(normalized),
        rows: Vec::new(),
        args: ActionArgs::WorkspaceWorkTierUpdate {
            mode,
            auto_target,
            before: None,
        },
    })
}

/// The workspace's link-preview switch as stored: a missing row is **on**
/// (ADR-0170 D4, `momo_unfurl::load_setting_in_tx`'s default). Read here rather
/// than through `momo-unfurl` so this crate does not pull in its fetcher.
pub async fn unfurl_enabled_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<bool, DbError> {
    let stored: Option<bool> = momo_db::sqlx::query_scalar(
        "SELECT enabled FROM workspace_unfurl_setting WHERE workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(stored.unwrap_or(true))
}

/// What [`read_installable_plugin_in_tx`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginRead {
    /// The app is not installed-and-enabled here: a card may offer it.
    Installable(InstallablePlugin),
    /// It already is: there is nothing to approve.
    AlreadyInstalled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallablePlugin {
    pub version: String,
    pub digest: String,
    pub egress_domains: Vec<String>,
    pub before: PluginInstallBefore,
}

/// A manifest version as a card may print it: short, one token.
fn plausible_version(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 32
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+_".contains(&byte))
}

/// A manifest egress domain as a card may print it. Looser than the server's
/// manifest admission on purpose (that is `momo-server`'s `plugin_manifest`, which
/// this crate cannot reach and which the install itself re-runs): this is only
/// "lowercase DNS characters with a dot", so nothing else can be drawn on a card.
fn plausible_egress_domain(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 253
        && text.contains('.')
        && !text.starts_with(['.', '-'])
        && !text.ends_with(['.', '-'])
        && text
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-".contains(&byte))
}

/// The registry row behind a `plugin.install` card and this workspace's install
/// state of it (ADR-0113 P2: the four, `official`, not revoked). `Ok(None)` is
/// "does not resolve" — including a manifest whose version or egress list does
/// not pass the card-text checks.
///
/// The digest is computed in SQL (`manifest::text` is Postgres's canonical jsonb
/// text, which no other process can reproduce), the same expression the registry
/// seeds and the server's admission use.
pub async fn read_installable_plugin_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    plugin_id: &str,
) -> Result<Option<PluginRead>, DbError> {
    use momo_db::sqlx::Row;
    let row = momo_db::sqlx::query(
        "SELECT pr.manifest #>> '{plugin,version}' AS version, \
                'sha256:' || encode(sha256(convert_to(pr.manifest::text, 'UTF8')), 'hex') AS digest, \
                COALESCE(pr.manifest #> '{momo,egressDomains}', '[]'::jsonb) AS egress, \
                wpi.id IS NOT NULL AS has_install, \
                COALESCE(wpi.revoked_at IS NOT NULL, false) AS removed, \
                COALESCE(wpi.enabled, false) AS enabled \
           FROM plugin_registry pr \
           LEFT JOIN workspace_plugin_install wpi \
             ON wpi.workspace_id = $1 AND wpi.plugin_id = pr.plugin_id \
          WHERE pr.plugin_id = $2 AND pr.official AND pr.revoked_at IS NULL",
    )
    .bind(workspace_id)
    .bind(plugin_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let version: Option<String> = row.try_get("version")?;
    let digest: String = row.try_get("digest")?;
    let egress: Value = row.try_get("egress")?;
    let has_install: bool = row.try_get("has_install")?;
    let removed: bool = row.try_get("removed")?;
    let enabled: bool = row.try_get("enabled")?;

    let Some(version) = version.filter(|version| plausible_version(version)) else {
        return Ok(None);
    };
    let Some(items) = egress.as_array().filter(|items| items.len() <= 16) else {
        return Ok(None);
    };
    let mut egress_domains = Vec::with_capacity(items.len());
    for item in items {
        match item
            .as_str()
            .filter(|domain| plausible_egress_domain(domain))
        {
            Some(domain) => egress_domains.push(domain.to_string()),
            None => return Ok(None),
        }
    }
    if has_install && !removed && enabled {
        return Ok(Some(PluginRead::AlreadyInstalled));
    }
    let before = if !has_install {
        PluginInstallBefore::NotInstalled
    } else if removed {
        PluginInstallBefore::Removed
    } else {
        PluginInstallBefore::Disabled
    };
    Ok(Some(PluginRead::Installable(InstallablePlugin {
        version,
        digest,
        egress_domains,
        before,
    })))
}

/// How a work-tier target reads on a card: 「oort Cloud」, a work host's display
/// name (quoted — it is user text), or 「(없는 호스트)」 for an id that names no
/// host of this workspace any more.
pub async fn work_tier_target_label_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    target: &str,
) -> Result<String, DbError> {
    if target == "cloud" {
        return Ok("oort Cloud".to_string());
    }
    let Ok(host_id) = Uuid::parse_str(target) else {
        return Ok("(없는 호스트)".to_string());
    };
    let name: Option<String> = momo_db::sqlx::query_scalar(
        "SELECT display_name FROM work_host WHERE id = $1 AND workspace_id = $2",
    )
    .bind(host_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match name {
        Some(name) => serde_json::to_string(&name).unwrap_or_default(),
        None => "(없는 호스트)".to_string(),
    })
}

pub fn hosted_channels_grant_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    // `channels` only: there is no connection, agent or id key to smuggle a
    // target through. The connection is the proposer's own, found server-side.
    closed_keys(object, &["channels"])?;
    let items = match object.get("channels") {
        Some(Value::Array(items)) => items,
        _ => return Err(ActionRejection::new("channels is required")),
    };
    if items.is_empty() || items.len() > actions::GRANT_CHANNELS_MAX as usize {
        return Err(ActionRejection::new("argument is out of range"));
    }
    let mut channel_refs: Vec<String> = Vec::new();
    for item in items {
        let Value::String(raw) = item else {
            return Err(ActionRejection::new("argument must be a string"));
        };
        let trimmed = raw.trim();
        let name = normalize_channel_name(trimmed.strip_prefix('#').unwrap_or(trimmed))
            .map_err(|invalid| ActionRejection::new(invalid.to_string()))?;
        if !channel_refs.contains(&name) {
            channel_refs.push(name);
        }
    }
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({"channels": channel_refs}),
        rows: Vec::new(),
        args: ActionArgs::HostedChannelsGrant {
            channel_refs,
            connection: None,
            channels: Vec::new(),
        },
    })
}

pub fn agent_rename_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &["displayName", "targetHandle"])?;
    let raw = optional_string(object, "displayName")?
        .ok_or_else(|| ActionRejection::new("displayName is required"))?;
    // The strict agent-proposal guard, not the join rule: this is the path that
    // must be unable to carry a link, a mention or an invisible character.
    // Which rule failed is not said.
    let display_name = validated_agent_proposed_display_name(raw)
        .map_err(|_| ActionRejection::new("display name is not allowed"))?;
    let target_handle = optional_string(object, "targetHandle")?
        .map(normalized_member_handle)
        .transpose()?;
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({"displayName": display_name, "targetHandle": target_handle}),
        rows: actions::agent_rename_rows("", target_handle.as_deref().unwrap_or(""), &display_name),
        args: ActionArgs::AgentRename {
            display_name,
            target_handle,
            target: None,
        },
    })
}

pub fn agent_invite_args(args: &Value) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    // Closed: no id, scope, channel or `ownerOnly`/subscription key can ride along.
    closed_keys(object, &["platform", "displayName", "handle"])?;
    let platform_key = optional_string(object, "platform")?
        .ok_or_else(|| ActionRejection::new("platform is required"))?;
    let (platform, _) = actions::AGENT_INVITE_PLATFORMS
        .iter()
        .find(|(key, _)| *key == platform_key)
        .ok_or_else(|| ActionRejection::new("platform is not allowed"))?;
    let raw_name = optional_string(object, "displayName")?
        .ok_or_else(|| ActionRejection::new("displayName is required"))?;
    // The strict agent-proposal guard (a link, a mention or an invisible
    // character cannot get through); which rule failed is not said.
    let display_name = validated_agent_proposed_display_name(raw_name)
        .map_err(|_| ActionRejection::new("display name is not allowed"))?;
    let raw_handle = optional_string(object, "handle")?
        .ok_or_else(|| ActionRejection::new("handle is required"))?;
    let handle = normalized_member_handle(raw_handle)
        .map_err(|_| ActionRejection::new("handle is not allowed"))?;
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({"platform": platform, "displayName": display_name, "handle": handle}),
        // The label is the registry's; the rows need the roster check first.
        rows: Vec::new(),
        args: ActionArgs::AgentInvite {
            platform,
            display_name,
            handle,
        },
    })
}

/// One text field of the card: absent = untouched, `null` = clear, a string =
/// the strict validator's normal form.
pub fn card_text_patch(
    object: &serde_json::Map<String, Value>,
    key: &str,
    validate: fn(&str) -> Result<String, momo_messaging::name_guard::NameRejected>,
) -> Result<FieldPatch, ActionRejection> {
    match object.get(key) {
        None => Ok(FieldPatch::Unchanged),
        Some(Value::Null) => Ok(FieldPatch::Clear),
        Some(Value::String(raw)) => validate(raw)
            .map(FieldPatch::Set)
            // Which rule failed is not said (V1-a: no oracle for the proposer).
            .map_err(|_| ActionRejection::new("profile text is not allowed")),
        Some(_) => Err(ActionRejection::new("argument must be a string")),
    }
}

pub fn agent_profile_update_args(
    args: &Value,
    origin: ArgsOrigin,
) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    let mut allowed: Vec<&str> = actions::PROFILE_UPDATE_FIELD_KEYS.to_vec();
    allowed.push("targetHandle");
    closed_keys(object, &allowed)?;

    let display_name = optional_string(object, "displayName")?
        .map(|raw| {
            validated_agent_proposed_display_name(raw)
                .map_err(|_| ActionRejection::new("display name is not allowed"))
        })
        .transpose()?;
    let tagline = card_text_patch(object, "tagline", validated_agent_tagline)?;
    let role_label = card_text_patch(object, "roleLabel", validated_agent_role_label)?;
    let target_handle = optional_string(object, "targetHandle")?
        .map(normalized_member_handle)
        .transpose()?;
    let avatar = avatar_intent(object, origin)?;

    // The status is replaced as a unit: any of its two keys present means the
    // whole status is being decided, and a key that is null/absent is empty.
    let status_keys = object.contains_key("statusText") || object.contains_key("statusEmoji");
    let status = if status_keys {
        let text = match card_text_patch(object, "statusText", validated_agent_status_text)? {
            FieldPatch::Set(text) => Some(text),
            _ => None,
        };
        let emoji = match card_text_patch(object, "statusEmoji", validated_agent_status_emoji)? {
            FieldPatch::Set(emoji) => Some(emoji),
            _ => None,
        };
        if text.is_none() && emoji.is_none() {
            if !object
                .get("statusExpiresInHours")
                .is_none_or(Value::is_null)
            {
                return Err(ActionRejection::new("a cleared status has no expiry"));
            }
            StatusIntent::Clear
        } else {
            let hours = bounded_integer(
                object,
                "statusExpiresInHours",
                1,
                actions::PROFILE_STATUS_HOURS_MAX,
            )?
            .unwrap_or(actions::PROFILE_STATUS_HOURS_DEFAULT);
            StatusIntent::Set { emoji, text, hours }
        }
    } else {
        if !object
            .get("statusExpiresInHours")
            .is_none_or(Value::is_null)
        {
            return Err(ActionRejection::new("statusExpiresInHours needs a status"));
        }
        StatusIntent::Unchanged
    };

    if display_name.is_none()
        && !tagline.is_touched()
        && !role_label.is_touched()
        && !avatar.is_touched()
        && status == StatusIntent::Unchanged
    {
        return Err(ActionRejection::new(
            "at least one profile field is required",
        ));
    }

    // `normalized` is stored as `approval.payload.action.args` and the decision
    // route re-runs it through this very function, so it must be written in the
    // **proposer's own spelling**: only the touched keys, `null` for a clear.
    let mut normalized = serde_json::Map::new();
    if let Some(name) = &display_name {
        normalized.insert("displayName".into(), json!(name));
    }
    for (key, patch) in [("tagline", &tagline), ("roleLabel", &role_label)] {
        match patch {
            FieldPatch::Unchanged => {}
            FieldPatch::Clear => {
                normalized.insert(key.into(), Value::Null);
            }
            FieldPatch::Set(text) => {
                normalized.insert(key.into(), json!(text));
            }
        }
    }
    match &status {
        StatusIntent::Unchanged => {}
        StatusIntent::Clear => {
            normalized.insert("statusText".into(), Value::Null);
            normalized.insert("statusEmoji".into(), Value::Null);
        }
        StatusIntent::Set { emoji, text, hours } => {
            normalized.insert("statusText".into(), json!(text));
            normalized.insert("statusEmoji".into(), json!(emoji));
            normalized.insert("statusExpiresInHours".into(), json!(hours));
        }
    }
    match &avatar {
        AvatarIntent::Unchanged => {}
        AvatarIntent::Clear => {
            normalized.insert("avatar".into(), Value::Null);
        }
        AvatarIntent::Preset(id) => {
            normalized.insert("avatar".into(), json!({"source": "preset", "presetId": id}));
        }
        // Never the bytes and never an id the agent chose: the proposal handler
        // replaces these with the staged form before anything is stored, and the
        // stored parser refuses them (`ArgsOrigin::Stored`).
        AvatarIntent::Attachment(_) => {
            normalized.insert("avatar".into(), json!({"source": "attachment"}));
        }
        AvatarIntent::Generated(_) => {
            normalized.insert("avatar".into(), json!({"source": "generated"}));
        }
        AvatarIntent::Staged {
            image_id,
            sha256,
            origin,
        } => {
            normalized.insert(
                "avatar".into(),
                json!({"source": "staged", "imageId": image_id.to_string(),
                       "sha256": sha256, "origin": origin}),
            );
        }
    }
    if let Some(handle) = &target_handle {
        normalized.insert("targetHandle".into(), json!(handle));
    }
    let normalized = Value::Object(normalized);
    Ok(ValidatedActionArgs {
        summary: None,
        normalized,
        // Rows need the target and the current values: the resolver builds them.
        rows: Vec::new(),
        args: ActionArgs::AgentProfileUpdate {
            display_name,
            tagline,
            role_label,
            status,
            avatar,
            target_handle,
            target: None,
            before: None,
        },
    })
}

/// `member.avatar.set` (ADR-0186 증보 v4): the **proposal** is `{attachmentId}` and nothing
/// else — no target, no URL, no bytes, no preset. The **stored** form is `{avatar:
/// {source:"staged", …}}`, which only this server writes; the proposal parser refuses it
/// and the stored parser refuses the raw `attachmentId`, exactly as for the agent's own
/// profile.
/// `message.pin` / `message.unpin` arguments: one id. Every other key — a channel, a URL, a
/// piece of text — is refused (`additionalProperties: false`), so nothing an agent writes can
/// name where the message is or describe what it says. The id is stored in its one canonical
/// spelling, so the pin's comparison cannot be defeated by a different way of writing it.
pub fn message_pin_args(
    args: &Value,
    change: PinAction,
) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    closed_keys(object, &["messageId"])?;
    let raw = match object.get("messageId") {
        Some(Value::String(raw)) => raw.as_str(),
        Some(_) => return Err(ActionRejection::new("messageId must be a string")),
        None => return Err(ActionRejection::new("messageId is required")),
    };
    // A uuid is 36 characters in its hyphenated form; anything longer is not an id, and the
    // parser's other spellings (braces, `urn:`) are not what `oort_conversation_read` gives.
    if raw.len() != 36 {
        return Err(ActionRejection::new("messageId must be an id"));
    }
    let message_id =
        Uuid::parse_str(raw).map_err(|_| ActionRejection::new("messageId must be an id"))?;
    Ok(ValidatedActionArgs {
        summary: None,
        normalized: json!({"messageId": message_id.to_string()}),
        // The rows are the message as the server reads it: the resolver builds them.
        rows: Vec::new(),
        args: ActionArgs::MessagePin {
            message_id,
            change,
            target: None,
        },
    })
}

pub fn member_avatar_set_args(
    args: &Value,
    origin: ArgsOrigin,
) -> Result<ValidatedActionArgs, ActionRejection> {
    let object = args
        .as_object()
        .ok_or_else(|| ActionRejection::new("action args must be an object"))?;
    let avatar = match origin {
        ArgsOrigin::Proposal => {
            closed_keys(object, &["attachmentId"])?;
            let raw = match object.get("attachmentId") {
                Some(Value::String(raw)) => raw.as_str(),
                Some(_) => return Err(ActionRejection::new("attachmentId must be a string")),
                None => return Err(ActionRejection::new("attachmentId is required")),
            };
            if raw.len() as u64 > actions::AVATAR_ID_TEXT_MAX_CHARS {
                return Err(ActionRejection::new("attachmentId is not allowed"));
            }
            let id = Uuid::parse_str(raw)
                .map_err(|_| ActionRejection::new("attachmentId must be an id"))?;
            AvatarIntent::Attachment(id)
        }
        ArgsOrigin::Stored => {
            closed_keys(object, &["avatar"])?;
            match avatar_intent(object, origin)? {
                staged @ AvatarIntent::Staged { .. } => staged,
                _ => return Err(ActionRejection::new("avatar is not allowed")),
            }
        }
    };
    let normalized = match &avatar {
        AvatarIntent::Attachment(_) => json!({"avatar": {"source": "attachment"}}),
        AvatarIntent::Staged {
            image_id,
            sha256,
            origin,
        } => json!({"avatar": {"source": "staged", "imageId": image_id.to_string(),
                               "sha256": sha256, "origin": origin}}),
        _ => return Err(ActionRejection::new("avatar is not allowed")),
    };
    Ok(ValidatedActionArgs {
        summary: None,
        normalized,
        // Rows need the person the run was raised by: the resolver builds them.
        rows: Vec::new(),
        args: ActionArgs::MemberAvatarSet {
            avatar,
            target: None,
        },
    })
}

/// The `avatar` argument. Closed shapes only; a URL, a mime, a size or any other
/// key is refused, and so is every shape the **origin** may not carry.
pub fn avatar_intent(
    object: &serde_json::Map<String, Value>,
    origin: ArgsOrigin,
) -> Result<AvatarIntent, ActionRejection> {
    let bad = || ActionRejection::new("avatar is not allowed");
    let map = match object.get("avatar") {
        None => return Ok(AvatarIntent::Unchanged),
        Some(Value::Null) => return Ok(AvatarIntent::Clear),
        Some(Value::Object(map)) => map,
        Some(_) => return Err(bad()),
    };
    let text = |key: &str| -> Result<&str, ActionRejection> {
        map.get(key).and_then(Value::as_str).ok_or_else(bad)
    };
    match text("source")? {
        "preset" => {
            closed_keys(map, &["source", "presetId"])?;
            let id = text("presetId")?;
            if !momo_messaging::is_avatar_preset(id) {
                return Err(bad());
            }
            Ok(AvatarIntent::Preset(id.to_string()))
        }
        "attachment" if origin == ArgsOrigin::Proposal => {
            closed_keys(map, &["source", "attachmentId"])?;
            let id = Uuid::parse_str(text("attachmentId")?).map_err(|_| bad())?;
            Ok(AvatarIntent::Attachment(id))
        }
        "generated" if origin == ArgsOrigin::Proposal => {
            closed_keys(map, &["source", "dataBase64"])?;
            let data = text("dataBase64")?;
            if data.is_empty() || data.len() as u64 > actions::AVATAR_GENERATED_B64_MAX_CHARS {
                return Err(bad());
            }
            Ok(AvatarIntent::Generated(data.to_string()))
        }
        "staged" if origin == ArgsOrigin::Stored => {
            closed_keys(map, &["source", "imageId", "sha256", "origin"])?;
            let image_id = Uuid::parse_str(text("imageId")?).map_err(|_| bad())?;
            let sha256 = text("sha256")?;
            if sha256.len() != 64
                || !sha256
                    .bytes()
                    .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            {
                return Err(bad());
            }
            let source = text("origin")?;
            if !momo_messaging::AGENT_AVATAR_SOURCES.contains(&source) {
                return Err(bad());
            }
            Ok(AvatarIntent::Staged {
                image_id,
                sha256: sha256.to_string(),
                origin: source.to_string(),
            })
        }
        _ => Err(bad()),
    }
}

/// How a status reads on a card: `🤖 집중 모드`, either half alone, or `None`.
pub fn status_display(emoji: Option<&str>, text: Option<&str>) -> Option<String> {
    let joined = [emoji, text]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    (!joined.is_empty()).then_some(joined)
}

/// The 「현재 → 새 값」 rows an `agent.profile.update` shows, one per field that
/// **actually changes** — `(label, before, after)`, `after = None` being a clear.
/// Used by the resolver (the card) and the executor (the result card), so the two
/// cannot describe different changes.
pub fn profile_changes(
    current_display_name: &str,
    card: &AgentCard,
    display_name: &Option<String>,
    tagline: &FieldPatch,
    role_label: &FieldPatch,
    status: &StatusIntent,
    avatar: &AvatarIntent,
) -> Vec<(&'static str, Option<String>, Option<String>)> {
    let mut changes = Vec::new();
    if let Some(name) = display_name {
        if name != current_display_name {
            changes.push((
                "이름",
                Some(current_display_name.to_string()),
                Some(name.clone()),
            ));
        }
    }
    for (label, patch, current) in [
        ("소개", tagline, &card.tagline),
        ("역할 라벨", role_label, &card.role_label),
    ] {
        let after = match patch {
            FieldPatch::Unchanged => continue,
            FieldPatch::Clear => None,
            FieldPatch::Set(text) => Some(text.clone()),
        };
        if &after != current {
            changes.push((label, current.clone(), after));
        }
    }
    let before_status = status_display(card.status_emoji.as_deref(), card.status_text.as_deref());
    match status {
        StatusIntent::Unchanged => {}
        StatusIntent::Clear => {
            if before_status.is_some() {
                changes.push(("상태", before_status, None));
            }
        }
        StatusIntent::Set { emoji, text, hours } => {
            let after = status_display(emoji.as_deref(), text.as_deref());
            if after != before_status {
                changes.push((
                    "상태",
                    before_status,
                    after.map(|shown| format!("{shown} ({hours}시간 동안)")),
                ));
            }
        }
    }
    // The picture: an approved image wins over a preset, so the "current" side is
    // the image when there is one.
    let before_avatar = if card.avatar_image_id.is_some() {
        Some("이미지".to_string())
    } else {
        card.avatar_preset.as_ref().map(|id| format!("프리셋 {id}"))
    };
    match avatar {
        AvatarIntent::Unchanged => {}
        AvatarIntent::Clear => {
            if before_avatar.is_some() {
                changes.push(("프로필 사진", before_avatar, None));
            }
        }
        AvatarIntent::Preset(_) => {
            let after = avatar.after_label();
            if after != before_avatar {
                changes.push(("프로필 사진", before_avatar, after));
            }
        }
        // A new image is always a change: it is a different picture even when the
        // agent already wears an image.
        AvatarIntent::Attachment(_) | AvatarIntent::Generated(_) | AvatarIntent::Staged { .. } => {
            changes.push(("프로필 사진", before_avatar, avatar.after_label()));
        }
    }
    changes
}

/// Resolve which agent a rename is about, under the V4-M trust model, or `None`.
///
/// * no `targetHandle` → the proposer itself;
/// * a handle that is the proposer's own → the proposer itself;
/// * any other handle → an **active agent whose `owner_human_id` equals the
///   proposer's, is not NULL, and is a currently active human member**.
///
/// Every other case — a human's handle, a missing handle, an agent of another
/// owner, an ownerless agent, a suspended agent — is the same `None`, so the
/// proposer cannot probe for agents it does not manage. The relationship is read
/// from `agent.owner_human_id`; it is never stored, and nothing an agent can do
/// creates or removes it.
pub async fn resolve_agent_rename_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    target_handle: Option<&str>,
) -> Result<Option<ResolvedAgentTarget>, momo_db::DbError> {
    let row: Option<(Uuid, String, String, Option<Uuid>)> = momo_db::sqlx::query_as(
        "SELECT m.id, m.handle, m.display_name, a.owner_human_id FROM member m \
           JOIN agent a ON a.workspace_id = m.workspace_id AND a.member_id = m.id \
          WHERE m.workspace_id = $1 AND m.kind = 'agent' AND m.status = 'active' \
            AND m.deleted_at IS NULL \
            AND (CASE WHEN $3::text IS NULL THEN m.id = $2 \
                      ELSE m.handle = $3 END)",
    )
    .bind(workspace_id)
    .bind(proposer_member_id)
    .bind(target_handle)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((id, handle, current_display_name, owner)) = row else {
        return Ok(None);
    };
    if id == proposer_member_id {
        return Ok(Some(ResolvedAgentTarget {
            id,
            handle,
            current_display_name,
            owner_member_id: owner,
            managed: false,
        }));
    }
    // Managed: the same, non-NULL, currently active human owner on both sides.
    let proposer_owner: Option<Option<Uuid>> = momo_db::sqlx::query_scalar(
        "SELECT owner_human_id FROM agent WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(proposer_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let (Some(Some(proposer_owner)), Some(target_owner)) = (proposer_owner, owner) else {
        return Ok(None);
    };
    if proposer_owner != target_owner {
        return Ok(None);
    }
    let owner_active: bool = momo_db::sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member o \
           JOIN workspace_membership wm \
             ON wm.workspace_id = o.workspace_id AND wm.member_id = o.id \
          WHERE o.workspace_id = $1 AND o.id = $2 AND o.kind = 'human' \
            AND o.status = 'active' AND o.deleted_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(target_owner)
    .fetch_one(&mut *conn)
    .await?;
    if !owner_active {
        return Ok(None);
    }
    Ok(Some(ResolvedAgentTarget {
        id,
        handle,
        current_display_name,
        owner_member_id: Some(target_owner),
        managed: true,
    }))
}

/// The one message an unresolvable avatar carries: the decision route recognises it
/// (the target did resolve, so the decider can be judged against it) and answers an
/// eligible decider with `action_args_invalid` instead of the generic refusal.
pub const AVATAR_UNRESOLVED: &str = "avatar did not resolve";

/// `sha256` as the stored form spells it (64 lowercase hex characters) → 32 bytes.
pub fn decode_sha256_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 {
        return None;
    }
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// The avatar part of an approval's pins: the staged image **and its hash**, or the
/// preset, or "clear". A raw `Attachment`/`Generated` intent has no pin — the
/// proposal handler stages it and overwrites this with the staged form.
pub fn avatar_pin(avatar: &AvatarIntent) -> Value {
    match avatar {
        AvatarIntent::Unchanged | AvatarIntent::Attachment(_) | AvatarIntent::Generated(_) => {
            Value::Null
        }
        AvatarIntent::Clear => json!({"clear": true}),
        AvatarIntent::Preset(id) => json!({"preset": id}),
        AvatarIntent::Staged {
            image_id, sha256, ..
        } => json!({"imageId": image_id.to_string(), "sha256": sha256}),
    }
}

/// The agent a proposal is **about** (an `agent.rename` / `agent.profile.update`
/// target), found **without judging any text** — or `None` when the proposal is not
/// about an agent, does not parse, or names someone the proposer does not manage.
///
/// The proposal path asks this *before* resolving, so the "someone else's proposal
/// is already waiting" answer (409) cannot depend on whether the text passes the
/// roster-name rules (which would turn 409-vs-400 into a roster oracle).
pub async fn early_target_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
) -> Result<Option<Uuid>, momo_db::DbError> {
    let Ok(validated) = validated_action_args(action, args, now_ms) else {
        return Ok(None);
    };
    let handle = match &validated.args {
        ActionArgs::AgentRename { target_handle, .. }
        | ActionArgs::AgentProfileUpdate { target_handle, .. } => target_handle,
        _ => return Ok(None),
    };
    Ok(
        resolve_agent_rename_target_in_tx(
            conn,
            workspace_id,
            proposer_member_id,
            handle.as_deref(),
        )
        .await?
        .map(|target| target.id),
    )
}

/// Find the channel a name points at **from the proposer's point of view**
/// (증보 V1-b): a live, non-DM channel that is public, or one the proposing agent
/// is a live member of. Everything else — somebody else's private channel, a DM,
/// an archived one, a name that does not exist — is `None`, so a refusal cannot
/// be used to learn that a private channel exists.
///
/// The channel row is locked `FOR SHARE` so it cannot be archived between this
/// read and the writes that follow.
pub async fn resolve_visible_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    name: &str,
) -> Result<Option<ResolvedChannel>, momo_db::DbError> {
    let row: Option<(Uuid, String, String, i64)> = momo_db::sqlx::query_as(
        "SELECT c.id, c.name, c.kind::text, \
                (SELECT count(*) FROM membership x \
                  WHERE x.workspace_id = c.workspace_id AND x.channel_id = c.id \
                    AND x.left_at IS NULL) \
           FROM channel c \
          WHERE c.workspace_id = $1 AND lower(c.name) = lower($2) \
            AND c.kind IN ('public', 'private') AND c.archived_at IS NULL \
            AND (c.kind = 'public' OR EXISTS ( \
                  SELECT 1 FROM membership p \
                   WHERE p.workspace_id = c.workspace_id AND p.channel_id = c.id \
                     AND p.member_id = $3 AND p.left_at IS NULL)) \
          FOR SHARE OF c",
    )
    .bind(workspace_id)
    .bind(name)
    .bind(proposer_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(id, name, kind, member_count)| ResolvedChannel {
        id,
        name,
        kind,
        member_count,
    }))
}

/// Look `handles` up among the workspace's active members.
/// Every handle must resolve: one that does not is the whole call's
/// `InvalidArguments`, with no hint which one.
pub async fn resolve_member_handles_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    handles: &[String],
) -> Result<Option<Vec<ResolvedMember>>, momo_db::DbError> {
    if handles.is_empty() {
        return Ok(Some(Vec::new()));
    }
    // No row lock: `add_channel_member_in_tx` re-checks `active` and
    // `deleted_at` in its own statement, and a `member` lock taken here would
    // sit before the hosted connection lock the executor takes next, against the
    // canon's order (connection first).
    let rows: Vec<(Uuid, String, String, String)> = momo_db::sqlx::query_as(
        "SELECT m.id, m.handle, m.display_name, m.kind::text FROM member m \
           JOIN workspace_membership wm \
             ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id \
          WHERE m.workspace_id = $1 AND m.handle = ANY($2) \
            AND m.status = 'active' AND m.deleted_at IS NULL \
          ORDER BY m.id",
    )
    .bind(workspace_id)
    .bind(handles)
    .fetch_all(&mut *conn)
    .await?;
    if rows.len() != handles.len() {
        return Ok(None);
    }
    // Re-order to the proposal's order so the card lists them as written.
    let mut members = Vec::with_capacity(rows.len());
    for handle in handles {
        let Some((id, handle, display_name, kind)) = rows.iter().find(|row| &row.1 == handle)
        else {
            return Ok(None);
        };
        members.push(ResolvedMember {
            id: *id,
            handle: handle.clone(),
            display_name: display_name.clone(),
            kind: kind.clone(),
        });
    }
    Ok(Some(members))
}

/// Find the message a pin action names **from the proposer's point of view** (ADR-0186 증보 v5
/// U-e), or `None` — and `None` is the one answer for every way it is not there to pin:
///
/// * no such id, or one in another workspace (RLS makes that the same as no row);
/// * a deleted message, or one that is not plain text (an approval card, a result line, a
///   system line: their state changes, so a pin on them would point at something else tomorrow);
/// * a channel that is archived;
/// * a channel **other than the one the run was raised in** — the card stands in the run's
///   channel, and it quotes the message, so a message from anywhere else would carry another
///   room's words to people who may not read them (review H2);
/// * a channel the proposer's own live hosted connection does not cover, or where the proposer
///   is no longer a live member (a DM the owner has not opened to the connection included);
/// * for `message.unpin`, a message that is not pinned.
///
/// `run_id` must be a run **of this proposer** whose channel is the message's channel; the run is
/// joined in the same statement, so no other combination can produce a row.
///
/// With `lock` (the decision's re-read) the message row is taken `FOR UPDATE` in the same
/// statement that hashes it: the body the approver was shown cannot change between this read and
/// the pin that follows. That is the very lock `set_pin_in_tx` takes next.
pub async fn resolve_pin_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    run_id: Uuid,
    message_id: Uuid,
    change: PinAction,
    lock: bool,
) -> Result<Option<ResolvedMessage>, momo_db::DbError> {
    resolve_pin_target_scoped_in_tx(
        conn,
        workspace_id,
        proposer_member_id,
        PinScope::RunChannel(run_id),
        message_id,
        change,
        lock,
    )
    .await
}

/// Where a pinned message may be, beyond everything [`resolve_pin_target_in_tx`] already requires
/// of the proposer (a live connection that covers the channel, a live membership, a plain
/// undeleted message in an unarchived channel, a pin to take off).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinScope {
    /// A card a person asked for: the message must be in **the run's own channel** (review H2).
    RunChannel(Uuid),
    /// An unasked card in `owner`'s direct message: the message may be in any channel, but
    /// `owner` must be a live member of it, so the card never quotes a room its reader is not in.
    Owner(Uuid),
    /// Only the proposer's own view — used by a producer to tell *who* failed the other scopes
    /// (the agent, or the owner), never to raise a card.
    AgentOnly,
}

/// [`resolve_pin_target_in_tx`] with its channel rule named (see [`PinScope`]).
pub async fn resolve_pin_target_scoped_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    scope: PinScope,
    message_id: Uuid,
    change: PinAction,
    lock: bool,
) -> Result<Option<ResolvedMessage>, momo_db::DbError> {
    use momo_db::sqlx::Row;

    // `$3` is the scope's subject in every variant — the run, the owner, or the nil uuid — and is
    // always referenced, so the statement's parameter list never changes shape.
    let (subject, run_join, scope_clause) = match scope {
        PinScope::RunChannel(run_id) => (
            run_id,
            "JOIN agent_run r ON r.workspace_id = m.workspace_id AND r.id = $3 \
                           AND r.agent_member_id = $2 AND r.channel_id = m.channel_id",
            "",
        ),
        PinScope::Owner(owner) => (
            owner,
            "",
            "AND EXISTS (SELECT 1 FROM membership o \
                          WHERE o.workspace_id = m.workspace_id AND o.channel_id = m.channel_id \
                            AND o.member_id = $3 AND o.left_at IS NULL)",
        ),
        PinScope::AgentOnly => (Uuid::nil(), "", "AND $3::uuid IS NOT NULL"),
    };

    // The proposer's own live connection — the only way a channel is "covered". No argument can
    // name another agent's.
    let Some(connection_id) =
        active_hosted_connection_in_tx(conn, workspace_id, proposer_member_id).await?
    else {
        return Ok(None);
    };
    let sql = format!(
        "SELECT m.channel_id, m.created_at, m.body, \
                c.name AS channel_name, c.kind::text AS channel_kind, \
                a.display_name AS author_name, a.handle AS author_handle, \
                a.kind::text AS author_kind, \
                CASE WHEN NULLIF(btrim(m.body), '') IS NOT NULL \
                     THEN encode(public.digest(convert_to('momo.pin.v1:body:' || m.body, 'UTF8'), \
                                               'sha256'), 'hex') \
                     ELSE encode(public.digest(convert_to('momo.pin.v1:attachments:' || \
                            coalesce((SELECT string_agg(t.id::text, ',' ORDER BY t.id) \
                                        FROM attachment t \
                                       WHERE t.workspace_id = m.workspace_id \
                                         AND t.message_id = m.id), ''), 'UTF8'), \
                                               'sha256'), 'hex') END AS body_sha256, \
                (SELECT count(*) FROM attachment t \
                  WHERE t.workspace_id = m.workspace_id AND t.message_id = m.id) AS attachments, \
                (SELECT count(*) FROM message_pin q WHERE q.channel_id = m.channel_id) AS pinned, \
                pin.pinned_by, pin.pinned_at, \
                pinner.display_name AS pinner_name, pinner.handle AS pinner_handle, \
                pinner.kind::text AS pinner_kind \
           FROM message m \
           JOIN channel c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id \
           {run_join} \
           JOIN member a ON a.workspace_id = m.workspace_id AND a.id = m.author_member_id \
           LEFT JOIN message_pin pin ON pin.message_id = m.id \
           LEFT JOIN member pinner \
             ON pinner.workspace_id = m.workspace_id AND pinner.id = pin.pinned_by \
          WHERE m.workspace_id = $1 AND m.id = $4 \
            AND m.type = 'text' AND m.state::text <> 'deleted' AND m.deleted_at IS NULL \
            AND c.archived_at IS NULL \
            AND EXISTS (SELECT 1 FROM membership p \
                         WHERE p.workspace_id = m.workspace_id AND p.channel_id = m.channel_id \
                           AND p.member_id = $2 AND p.left_at IS NULL) \
            AND m.channel_id = ANY(hosted_connection_channel_ids($1, $5)) \
            {scope_clause} \
            AND ($6 = false OR pin.message_id IS NOT NULL){lock_clause}",
        lock_clause = if lock { " FOR UPDATE OF m" } else { "" }
    );
    let Some(row) = momo_db::sqlx::query(&sql)
        .bind(workspace_id)
        .bind(proposer_member_id)
        .bind(subject)
        .bind(message_id)
        .bind(connection_id)
        .bind(change == PinAction::Unpinned)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };

    let channel_id: Uuid = row.try_get("channel_id")?;
    let body: Option<String> = row.try_get("body")?;
    let (excerpt, total, truncated) = actions::pin_card_excerpt(body.as_deref().unwrap_or(""));
    let has_text = body.as_deref().is_some_and(|text| !text.trim().is_empty());
    let pinned_by_label = match row.try_get::<Option<Uuid>, _>("pinned_by")? {
        Some(_) => Some(actions::member_card_label(
            &row.try_get::<String, _>("pinner_name")?,
            &row.try_get::<String, _>("pinner_handle")?,
            row.try_get::<String, _>("pinner_kind")? == "agent",
        )),
        None => None,
    };
    let card = actions::PinCardMessage {
        // A DM has no name: `channel.name` is NULL for `kind = 'dm'` (001_init.sql), and the owner's
        // 1:1 DM with the agent is the room this action is most often asked in. The card calls
        // it 「1:1 대화」 and never prints the name, so a missing name is not a failed read.
        channel_name: row
            .try_get::<Option<String>, _>("channel_name")?
            .unwrap_or_default(),
        channel_kind: row.try_get("channel_kind")?,
        author_label: actions::member_card_label(
            &row.try_get::<String, _>("author_name")?,
            &row.try_get::<String, _>("author_handle")?,
            row.try_get::<String, _>("author_kind")? == "agent",
        ),
        created_at: row.try_get("created_at")?,
        excerpt,
        total_chars: has_text.then_some(total as i64),
        truncated,
        attachment_count: row.try_get("attachments")?,
        pinned_count: row.try_get("pinned")?,
        pinned_by_label,
        pinned_at: row.try_get("pinned_at")?,
    };
    Ok(Some(ResolvedMessage {
        id: message_id,
        channel_id,
        body_sha256: row.try_get("body_sha256")?,
        card,
    }))
}

/// The proposer must be an active, unpaused agent member of this workspace *now*
/// (the hosted identity check requires `paused = false` too).
pub async fn proposer_is_live_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
) -> Result<bool, momo_db::DbError> {
    Ok(momo_db::sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM member m \
           JOIN workspace_membership wm \
             ON wm.workspace_id = m.workspace_id AND wm.member_id = m.id \
          WHERE m.workspace_id = $1 AND m.id = $2 AND m.kind = 'agent' \
            AND m.status = 'active' AND m.deleted_at IS NULL \
            AND NOT EXISTS (SELECT 1 FROM agent_profile ap \
                             WHERE ap.workspace_id = m.workspace_id \
                               AND ap.agent_member_id = m.id AND ap.paused))",
    )
    .bind(workspace_id)
    .bind(proposer_member_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// Is `member_id` a live member of `channel_id`? (`membership.left_at IS NULL`.)
pub async fn member_is_live_in_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, momo_db::DbError> {
    Ok(momo_db::sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM membership \
          WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3 AND left_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// What the role gate of a [`actions::RequiredRole`] is judged against.
///
/// Most roles are about the workspace as a whole and need no subject. The
/// agent-scoped one (`AgentEditor`) is about **one agent**, which is only known
/// after the arguments are resolved — so the subject travels with the resolved
/// action, and the decision route judges the role against it rather than against
/// anything the card or the proposer asserted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateSubject {
    Workspace,
    /// The target agent's `member.id` (ADR-0186 증보 V4-M: the target, never the
    /// proposer).
    Agent(Uuid),
    /// The **person** the action changes (`member.avatar.set`): the human who raised the
    /// run, derived by the server — the role gate is "the decider is this member".
    Member(Uuid),
}

/// A proposal after the database has agreed to it (ADR-0186 증보 V1-a/d).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAction {
    /// `normalized` is stored in the payload, `rows` is drawn on the card and
    /// `args` is what the executor acts on — all three built from the values the
    /// resolution found, not from the strings the agent typed.
    pub validated: ValidatedActionArgs,
    pub subject: GateSubject,
    /// The **ids** the names resolved to (`Value::Null` when the action names
    /// nothing). Stored beside the args at proposal time and compared at
    /// decision time: a handle can be changed and a channel can be renamed, so
    /// "the same name resolves again" is not "the same thing the approver read".
    /// A different id at decision time is `action_args_invalid`.
    pub pins: Value,
}

/// Shape-validate `args`, then resolve whatever they name against the workspace,
/// inside the caller's tenant transaction.
///
/// `proposer_member_id` is the agent that raised the proposal: it is whose view
/// "visible channel" is measured from, and the actor a resolution rule such as
/// "same owner" starts from. The outer `Result` is the database; the inner one
/// is the verdict, and every inner `Err` is a 400 that
/// `agent_port_tools::failure_of` turns into the one `InvalidArguments` — a
/// resolution failure never says *which* name did not resolve.
///
/// Called with the stored payload at decision time too, so a card is re-proved
/// against the workspace as it is now (D2: 「저장값을 신뢰하지 않는다」).
///
/// `run_id` is the agent run the proposal was raised in, when there is one: an action
/// whose subject is *the person who called the agent* (`member.avatar.set`) derives that
/// person from it and refuses without one. The team AI has no run, so it passes `None`.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_action_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    run_id: Option<Uuid>,
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
) -> ResolveOutcome<ResolvedAction> {
    resolve_action_with_origin_in_tx(
        conn,
        workspace_id,
        proposer_member_id,
        run_id,
        action,
        args,
        now_ms,
        ArgsOrigin::Proposal,
        None,
        CardAudience::RunChannel,
    )
    .await
}

/// [`resolve_action_in_tx`] for a card **nobody asked for** (ADR-0186 증보 v5 U-b-4 6): the
/// card will stand in `owner`'s direct message, so the arguments are judged for that reader
/// ([`CardAudience::Owner`]) and there is no run yet to name (it is born after this passes).
#[allow(clippy::too_many_arguments)]
pub async fn resolve_initiative_action_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    owner_member_id: Uuid,
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
) -> ResolveOutcome<ResolvedAction> {
    resolve_action_with_origin_in_tx(
        conn,
        workspace_id,
        proposer_member_id,
        None,
        action,
        args,
        now_ms,
        ArgsOrigin::Proposal,
        None,
        CardAudience::Owner(owner_member_id),
    )
    .await
}

/// [`resolve_stored_action_in_tx`] for an unasked card: the decision's re-proof, judged for the
/// `reader` — the member who is deciding it, who must be able to read everything the card
/// quotes (and, for a pin, to pin it: `set_pin_in_tx` requires the approver's own membership).
#[allow(clippy::too_many_arguments)]
pub async fn resolve_stored_initiative_action_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    reader_member_id: Uuid,
    run_id: Option<Uuid>,
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
    approval_id: Uuid,
) -> ResolveOutcome<ResolvedAction> {
    resolve_action_with_origin_in_tx(
        conn,
        workspace_id,
        proposer_member_id,
        run_id,
        action,
        args,
        now_ms,
        ArgsOrigin::Stored,
        Some(approval_id),
        CardAudience::Owner(reader_member_id),
    )
    .await
}

/// [`resolve_action_in_tx`] for the arguments the **server stored** at proposal
/// time (the decision route): the one place [`ArgsOrigin::Stored`] is used.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_stored_action_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    run_id: Option<Uuid>,
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
    approval_id: Uuid,
) -> ResolveOutcome<ResolvedAction> {
    resolve_action_with_origin_in_tx(
        conn,
        workspace_id,
        proposer_member_id,
        run_id,
        action,
        args,
        now_ms,
        ArgsOrigin::Stored,
        Some(approval_id),
        CardAudience::RunChannel,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn resolve_action_with_origin_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    run_id: Option<Uuid>,
    action: &WorkspaceAction,
    args: &Value,
    now_ms: i64,
    origin: ArgsOrigin,
    decision_approval_id: Option<Uuid>,
    audience: CardAudience,
) -> ResolveOutcome<ResolvedAction> {
    let mut validated = match validated_action_args_from(action, args, now_ms, origin) {
        Ok(validated) => validated,
        Err(error) => return Ok(Err(error)),
    };
    // An unasked card adds its own checks to the action's — on the proposal and on the stored
    // arguments alike (`initiative_args_checks`).
    if matches!(audience, CardAudience::Owner(_)) {
        if let Err(error) = initiative_args_checks(&mut validated) {
            return Ok(Err(error));
        }
    }
    // Exhaustive on purpose: a new `ActionArgs` variant must say here whether it
    // resolves anything and whom its role gate is about.
    let subject = match &mut validated.args {
        ActionArgs::InviteCreate { .. } => GateSubject::Workspace,
        ActionArgs::AgentInvite {
            platform,
            display_name,
            handle,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // The collision check and the later INSERT must see the same roster.
            lock_display_name_namespace_in_tx(conn, workspace_id).await?;
            let roster = load_roster_names_in_tx(conn, workspace_id, Uuid::nil()).await?;
            let names: Vec<RosterName<'_>> = roster
                .iter()
                .map(|(member_id, display_name, handle)| RosterName {
                    member_id: *member_id,
                    display_name,
                    handle,
                })
                .collect();
            // Nobody to exclude: the new agent is not in the roster yet.
            if conflicts_with_roster(display_name, Uuid::nil(), &names)
                || mention_overlaps_roster(display_name, Uuid::nil(), &names)
                || conflicts_with_roster(handle, Uuid::nil(), &names)
                // The handle is spoken as `@handle`: it gets the name rules too
                // (reserved words) and the mention-overlap rule (I1 review M1/M2).
                || validated_agent_proposed_display_name(handle).is_err()
                || mention_overlaps_roster(handle, Uuid::nil(), &names)
                // A deleted member still holds its handle (unique index), which
                // the roster does not list (I1 review L1).
                || momo_db::sqlx::query_scalar::<_, bool>(
                    "SELECT EXISTS (SELECT 1 FROM member WHERE workspace_id = $1 AND handle = $2)",
                )
                .bind(workspace_id)
                .bind(handle.as_str())
                .fetch_one(&mut *conn)
                .await?
                || momo_settings::is_handle_banned_in_tx(conn, handle).await?
            {
                return Ok(Err(ActionRejection::new("agent name is not allowed")));
            }
            let label = actions::agent_invite_platform_label(platform).unwrap_or("");
            validated.rows = actions::agent_invite_rows(label, display_name, handle);
            GateSubject::Workspace
        }
        ActionArgs::ChannelCreate {
            name,
            kind,
            topic,
            add_proposer,
            handles,
            members,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            let Some(found) = resolve_member_handles_in_tx(conn, workspace_id, handles).await?
            else {
                return Ok(Err(ActionRejection::new("member handle did not resolve")));
            };
            // `addProposer: false` with the proposer's own handle in the list
            // would make the card contradict itself (「참여: 아니요」 beside the
            // agent in the member list) and seat the agent anyway.
            if !*add_proposer && found.iter().any(|member| member.id == proposer_member_id) {
                return Ok(Err(ActionRejection::new(
                    "the proposer cannot be a listed member when addProposer is false",
                )));
            }
            *members = found;
            let names: Vec<String> = members.iter().map(ResolvedMember::card_label).collect();
            validated.rows =
                actions::channel_create_rows(name, kind, topic.as_deref(), *add_proposer, &names);
            GateSubject::Workspace
        }
        ActionArgs::WorkspaceSettingsUpdate {
            welcome_prompt,
            role_labels,
            before,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            let Some(bag) = read_workspace_settings(conn, workspace_id).await? else {
                return Ok(Err(ActionRejection::new("workspace settings unavailable")));
            };
            // What the touched keys hold NOW: the card's 「옛 값」 and the pins.
            before.welcome_prompt = welcome_prompt
                .is_touched()
                .then(|| bag.get("welcome_prompt").cloned())
                .flatten();
            before.role_labels = role_labels
                .is_touched()
                .then(|| bag.get("role_labels").cloned())
                .flatten();
            let mut rows = Vec::new();
            let mut changed = false;
            for (patch, was, (_, _, label)) in [
                (&*welcome_prompt, &before.welcome_prompt, SETTINGS_KEYS[0]),
                (&*role_labels, &before.role_labels, SETTINGS_KEYS[1]),
            ] {
                let after = match patch {
                    SettingPatch::Unchanged => continue,
                    SettingPatch::Clear => None,
                    SettingPatch::Set(value) => Some(value),
                };
                // A proposal that changes nothing is not a proposal.
                if after != was.as_ref() {
                    changed = true;
                }
                rows.push(actions::settings_change_row(
                    label,
                    settings_display(was.as_ref()).as_deref(),
                    settings_display(after).as_deref(),
                ));
            }
            if !changed {
                return Ok(Err(ActionRejection::new("nothing to change")));
            }
            validated.rows = rows;
            GateSubject::Workspace
        }
        ActionArgs::WorkspaceUnfurlUpdate { enabled, before } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            let current = unfurl_enabled_in_tx(conn, workspace_id).await?;
            // A proposal that changes nothing is not a proposal.
            if current == *enabled {
                return Ok(Err(ActionRejection::new("nothing to change")));
            }
            *before = Some(current);
            validated.rows = actions::unfurl_update_rows(current, *enabled);
            GateSubject::Workspace
        }
        ActionArgs::WorkspaceMemoryUpdate { .. } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // The rows were drawn from the arguments by the normaliser; there is
            // nothing in the workspace to resolve (see the variant's note).
            GateSubject::Workspace
        }
        ActionArgs::WorkspaceWorkTierUpdate {
            mode,
            auto_target,
            before,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            let current = momo_settings::load_tier_policy(
                conn,
                workspace_id,
                momo_settings::TierScope::Workspace,
            )
            .await?;
            if current.mode == *mode && current.auto_target == *auto_target {
                return Ok(Err(ActionRejection::new("nothing to change")));
            }
            // The REST route's registry check: the host must be live and
            // workspace-scoped (`FOR SHARE`, so it cannot be revoked under us).
            if momo_settings::tier_target_allowed(
                conn,
                workspace_id,
                momo_settings::TierScope::Workspace,
                auto_target.as_deref(),
            )
            .await?
            .is_err()
            {
                return Ok(Err(ActionRejection::new("auto target is not available")));
            }
            let before_label = match &current.auto_target {
                Some(target) => {
                    Some(work_tier_target_label_in_tx(conn, workspace_id, target).await?)
                }
                None => None,
            };
            let after_label = match auto_target.as_deref() {
                Some(target) => {
                    Some(work_tier_target_label_in_tx(conn, workspace_id, target).await?)
                }
                None => None,
            };
            validated.rows = actions::work_tier_update_rows(
                &current.mode,
                before_label.as_deref(),
                mode,
                after_label.as_deref(),
            );
            *before = Some((current.mode, current.auto_target));
            GateSubject::Workspace
        }
        ActionArgs::HostedChannelsGrant {
            channel_refs,
            connection,
            channels,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // The connection row is locked FIRST (the hosted canon's order:
            // connection before channel and membership rows). Only the
            // proposer's OWN live connection can be found; no argument names
            // another agent's.
            let Some((connection_id, approved_before)) =
                lock_active_hosted_connection_in_tx(conn, workspace_id, proposer_member_id).await?
            else {
                return Ok(Err(ActionRejection::new("no live hosted connection")));
            };
            let approved: Vec<Uuid> = momo_db::sqlx::query_scalar(
                "SELECT unnest(approved_channel_ids) FROM hosted_agent_connection \
                  WHERE workspace_id = $1 AND id = $2",
            )
            .bind(workspace_id)
            .bind(connection_id)
            .fetch_all(&mut *conn)
            .await?;
            let mut new_channels: Vec<ResolvedChannel> = Vec::new();
            for channel_ref in channel_refs.iter() {
                // The same single answer as every unseen channel: somebody
                // else's private room, a DM, an archived or missing one.
                let Some(found) = resolve_visible_channel_in_tx(
                    conn,
                    workspace_id,
                    proposer_member_id,
                    channel_ref,
                )
                .await?
                else {
                    return Ok(Err(ActionRejection::new("channel did not resolve")));
                };
                if !approved.contains(&found.id)
                    && !new_channels.iter().any(|known| known.id == found.id)
                {
                    new_channels.push(found);
                }
            }
            if new_channels.is_empty()
                || approved_before + new_channels.len() > MAX_HOSTED_APPROVED_CHANNELS
            {
                // Nothing to widen, or past the ceiling (증보 V5: 50).
                return Ok(Err(ActionRejection::new("channels cannot be granted")));
            }
            validated.rows = actions::hosted_channels_grant_rows(
                &new_channels
                    .iter()
                    .map(|c| (c.name.clone(), c.kind.clone(), c.member_count))
                    .collect::<Vec<_>>(),
                approved_before,
                approved_before + new_channels.len(),
            );
            *connection = Some(ResolvedConnection {
                id: connection_id,
                approved_before,
            });
            *channels = new_channels;
            GateSubject::Workspace
        }
        ActionArgs::AgentRename {
            display_name,
            target_handle,
            target,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            let Some(found) = resolve_agent_rename_target_in_tx(
                conn,
                workspace_id,
                proposer_member_id,
                target_handle.as_deref(),
            )
            .await?
            else {
                return Ok(Err(ActionRejection::new("rename target did not resolve")));
            };
            // The collision check and the write must see the same roster:
            // serialise renames of this workspace for the rest of the transaction.
            lock_display_name_namespace_in_tx(conn, workspace_id).await?;
            let roster = load_roster_names_in_tx(conn, workspace_id, found.id).await?;
            let names: Vec<RosterName<'_>> = roster
                .iter()
                .map(|(member_id, display_name, handle)| RosterName {
                    member_id: *member_id,
                    display_name,
                    handle,
                })
                .collect();
            if conflicts_with_roster(display_name, found.id, &names)
                || mention_overlaps_roster(display_name, found.id, &names)
            {
                return Ok(Err(ActionRejection::new("display name is not allowed")));
            }
            validated.rows = actions::agent_rename_rows(
                &found.current_display_name,
                &found.handle,
                display_name,
            );
            if found.managed {
                validated.summary = Some(actions::AGENT_RENAME_MANAGED_SUMMARY.to_string());
            }
            let subject = GateSubject::Agent(found.id);
            *target = Some(found);
            subject
        }
        ActionArgs::AgentProfileUpdate {
            display_name,
            tagline,
            role_label,
            status,
            avatar,
            target_handle,
            target,
            before,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // The V4-M target rule, the one `agent.rename` uses; every miss is
            // the same answer so nothing about other agents can be probed.
            let Some(found) = resolve_agent_rename_target_in_tx(
                conn,
                workspace_id,
                proposer_member_id,
                target_handle.as_deref(),
            )
            .await?
            else {
                return Ok(Err(ActionRejection::new("profile target did not resolve")));
            };
            let Some(card) = read_agent_card_in_tx(conn, workspace_id, found.id).await? else {
                return Ok(Err(ActionRejection::new("profile target did not resolve")));
            };
            // Names, taglines and labels are read next to other members' names:
            // serialise with renames for the rest of the transaction.
            lock_display_name_namespace_in_tx(conn, workspace_id).await?;
            let roster = load_roster_names_in_tx(conn, workspace_id, found.id).await?;
            let names: Vec<RosterName<'_>> = roster
                .iter()
                .map(|(member_id, display_name, handle)| RosterName {
                    member_id: *member_id,
                    display_name,
                    handle,
                })
                .collect();
            if let Some(name) = display_name.as_deref() {
                if name != found.current_display_name
                    && (conflicts_with_roster(name, found.id, &names)
                        || mention_overlaps_roster(name, found.id, &names))
                {
                    return Ok(Err(ActionRejection::new("display name is not allowed")));
                }
            }
            // A line that repeats another member's name reads as something that
            // member said or endorsed.
            let mut texts: Vec<&str> = Vec::new();
            if let FieldPatch::Set(text) = tagline {
                texts.push(text);
            }
            if let FieldPatch::Set(text) = role_label {
                texts.push(text);
            }
            if let StatusIntent::Set {
                text: Some(text), ..
            } = status
            {
                texts.push(text);
            }
            if texts
                .iter()
                .any(|text| text_repeats_roster_name(text, found.id, &names))
            {
                return Ok(Err(ActionRejection::new("profile text is not allowed")));
            }
            // A role label may not equal a default role word (「멤버」·「게스트」…) or
            // one the workspace itself defines, nor contain a defined one
            // (「Captain Bot」 under a 「Captain」 override): that is a label with
            // authority behind it.
            if let FieldPatch::Set(label) = role_label {
                let Some(bag) = read_workspace_settings(conn, workspace_id).await? else {
                    return Ok(Err(ActionRejection::new("workspace settings unavailable")));
                };
                let labels = momo_settings::project_role_labels(&bag);
                let defined: Vec<&str> = labels
                    .as_object()
                    .map(|map| map.values().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                if role_label_collides(label, &defined) {
                    return Ok(Err(ActionRejection::new("profile text is not allowed")));
                }
            }
            // A staged image is what the approver was shown: it must still be the
            // proposer's own staging for **this** target, still `staged`, and its
            // stored bytes must still hash to the pin (the database recomputes the
            // digest, so an edit around the immutability trigger is caught).
            if let AvatarIntent::Staged {
                image_id, sha256, ..
            } = avatar
            {
                let pin = decode_sha256_hex(sha256);
                let row =
                    momo_messaging::read_avatar_image_in_tx(conn, workspace_id, *image_id).await?;
                let bound = row.is_some_and(|row| {
                    row.member_id == found.id
                        && row.proposed_by == proposer_member_id
                        && row.status == "staged"
                        // Bound to the approval being decided, in the database's own
                        // record — a pin naming another approval's image is refused.
                        && decision_approval_id.is_some()
                        && row.approval_id == decision_approval_id
                });
                let intact = match (&pin, bound, decision_approval_id) {
                    (Some(pin), true, Some(approval_id)) => {
                        momo_messaging::staged_image_matches_pin_in_tx(
                            conn,
                            workspace_id,
                            *image_id,
                            found.id,
                            approval_id,
                            pin,
                        )
                        .await?
                    }
                    _ => false,
                };
                if !intact {
                    return Ok(Err(ActionRejection::new(AVATAR_UNRESOLVED)));
                }
            }
            let changes = profile_changes(
                &found.current_display_name,
                &card,
                display_name,
                tagline,
                role_label,
                status,
                avatar,
            );
            // A proposal that changes nothing is not a proposal.
            if changes.is_empty() {
                return Ok(Err(ActionRejection::new("nothing to change")));
            }
            validated.rows = actions::agent_profile_update_rows(
                &found.current_display_name,
                &found.handle,
                &changes,
            );
            if found.managed {
                validated.summary = Some(actions::AGENT_PROFILE_MANAGED_SUMMARY.to_string());
            }
            let subject = GateSubject::Agent(found.id);
            *target = Some(found);
            *before = Some(card);
            subject
        }
        ActionArgs::MemberAvatarSet { avatar, target } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // **The person is the one who called this agent, found from the run — never
            // from an argument.** No run (the team AI), another agent's run, a run nobody
            // addressed, a trigger an agent wrote: the same refusal.
            let Some(run_id) = run_id else {
                return Ok(Err(ActionRejection::new("avatar target did not resolve")));
            };
            let Some((requester, run_channel)) = momo_messaging::requester_of_run_in_tx(
                conn,
                workspace_id,
                run_id,
                proposer_member_id,
            )
            .await?
            else {
                return Ok(Err(ActionRejection::new("avatar target did not resolve")));
            };
            let person = momo_db::sqlx::query(
                "SELECT display_name, handle, \
                        (avatar_media_id IS NOT NULL OR avatar_image_id IS NOT NULL \
                         OR avatar_url IS NOT NULL) AS had_avatar \
                   FROM member WHERE workspace_id = $1 AND id = $2",
            )
            .bind(workspace_id)
            .bind(requester)
            .fetch_optional(&mut *conn)
            .await?;
            let Some(person) = person else {
                return Ok(Err(ActionRejection::new("avatar target did not resolve")));
            };
            let person = {
                use momo_db::sqlx::Row;
                ResolvedPerson {
                    id: requester,
                    display_name: person.try_get("display_name")?,
                    handle: person.try_get("handle")?,
                    had_avatar: person.try_get("had_avatar")?,
                }
            };
            match avatar {
                // A proposal: the file must be one **this person** attached **in the
                // conversation the agent was called in** (the same query the handler's
                // download used). The handler stages it; this proves it again in the
                // transaction that writes the card.
                AvatarIntent::Attachment(attachment_id) => {
                    let found = momo_messaging::find_requester_attachment_in_tx(
                        conn,
                        workspace_id,
                        requester,
                        run_channel,
                        *attachment_id,
                        momo_messaging::AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT as i64,
                    )
                    .await?;
                    if found.is_none() {
                        return Ok(Err(ActionRejection::new("avatar is not allowed")));
                    }
                }
                // A decision: the image the person was shown must still be the proposer's
                // own staging for **this person**, still `staged`, bound to the approval
                // being decided, and its stored bytes must still hash to the pin.
                AvatarIntent::Staged {
                    image_id, sha256, ..
                } => {
                    let pin = decode_sha256_hex(sha256);
                    let row =
                        momo_messaging::read_avatar_image_in_tx(conn, workspace_id, *image_id)
                            .await?;
                    let bound = row.is_some_and(|row| {
                        row.member_id == requester
                            && row.proposed_by == proposer_member_id
                            && row.status == "staged"
                            && decision_approval_id.is_some()
                            && row.approval_id == decision_approval_id
                    });
                    let intact = match (&pin, bound, decision_approval_id) {
                        (Some(pin), true, Some(approval_id)) => {
                            momo_messaging::staged_image_matches_pin_in_tx(
                                conn,
                                workspace_id,
                                *image_id,
                                requester,
                                approval_id,
                                pin,
                            )
                            .await?
                        }
                        _ => false,
                    };
                    if !intact {
                        return Ok(Err(ActionRejection::new(AVATAR_UNRESOLVED)));
                    }
                }
                _ => return Ok(Err(ActionRejection::new("avatar is not allowed"))),
            }
            validated.rows = actions::member_avatar_set_rows(
                &person.display_name,
                &person.handle,
                person.had_avatar,
            );
            let subject = GateSubject::Member(requester);
            *target = Some(person);
            subject
        }
        ActionArgs::PluginInstall { plugin_id, plugin } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // One answer for every way the app is not there to install: not one
            // of the four, revoked or unofficial in the registry, or a manifest
            // whose text does not look like what a card may say.
            let Some(found) = read_installable_plugin_in_tx(conn, workspace_id, plugin_id).await?
            else {
                return Ok(Err(ActionRejection::new("plugin did not resolve")));
            };
            let Some(label) = actions::plugin_install_label(plugin_id) else {
                return Ok(Err(ActionRejection::new("plugin did not resolve")));
            };
            // A proposal that changes nothing is not a proposal.
            let PluginRead::Installable(read) = found else {
                return Ok(Err(ActionRejection::new("nothing to change")));
            };
            validated.rows = actions::plugin_install_rows(
                label,
                &read.version,
                &read.egress_domains,
                read.before,
            );
            validated.summary = Some(actions::plugin_install_summary(label));
            *plugin = Some(ResolvedPlugin {
                label,
                version: read.version,
                digest: read.digest,
                egress_domains: read.egress_domains,
                before: read.before,
            });
            GateSubject::Workspace
        }
        ActionArgs::MessagePin {
            message_id,
            change,
            target,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // The decision's re-read takes the row lock (`decision_approval_id` is only set
            // there); a proposal reads without one.
            let lock = decision_approval_id.is_some();
            let found = match audience {
                // A card stands in a run's channel and quotes the message: with no run (the team
                // AI has none to stand on) there is nowhere the card could safely quote it.
                CardAudience::RunChannel => {
                    let Some(run_id) = run_id else {
                        return Ok(Err(ActionRejection::new("message did not resolve")));
                    };
                    resolve_pin_target_scoped_in_tx(
                        conn,
                        workspace_id,
                        proposer_member_id,
                        PinScope::RunChannel(run_id),
                        *message_id,
                        *change,
                        lock,
                    )
                    .await?
                }
                // An unasked card has no run at proposal time, and the run's channel is the DM
                // itself: the message may be in any channel its reader is in.
                CardAudience::Owner(reader) => {
                    let found = resolve_pin_target_scoped_in_tx(
                        conn,
                        workspace_id,
                        proposer_member_id,
                        PinScope::Owner(reader),
                        *message_id,
                        *change,
                        lock,
                    )
                    .await?;
                    if found.is_none()
                        && resolve_pin_target_scoped_in_tx(
                            conn,
                            workspace_id,
                            proposer_member_id,
                            PinScope::AgentOnly,
                            *message_id,
                            *change,
                            false,
                        )
                        .await?
                        .is_some()
                    {
                        // The agent can see it and its reader cannot: the owner's side.
                        return Ok(Err(ActionRejection::new(OWNER_CANNOT_SEE)));
                    }
                    found
                }
            };
            let Some(found) = found else {
                return Ok(Err(ActionRejection::new("message did not resolve")));
            };
            validated.rows = actions::message_pin_rows(*change == PinAction::Unpinned, &found.card);
            *target = Some(found);
            GateSubject::Workspace
        }
        ActionArgs::ChannelMemberAdd {
            channel_ref,
            handles,
            channel,
            members,
            already_in,
        } => {
            if !proposer_is_live_agent_in_tx(conn, workspace_id, proposer_member_id).await? {
                return Ok(Err(ActionRejection::new("proposer is not an active agent")));
            }
            // One answer for "no such channel", "somebody's private channel", "a
            // DM" and "archived" (and for an unresolvable handle below).
            let Some(found) =
                resolve_visible_channel_in_tx(conn, workspace_id, proposer_member_id, channel_ref)
                    .await?
            else {
                return Ok(Err(ActionRejection::new("channel did not resolve")));
            };
            // An unasked card stands in the owner's DM and names this channel: a private room
            // its reader is not in must not be named to them by a card (ADR U-b-4 6). Judged
            // after the agent's own view, so the two failures stay distinguishable to the
            // producer (and only to it).
            if let CardAudience::Owner(reader) = audience {
                if found.kind != "public"
                    && !member_is_live_in_channel_in_tx(conn, workspace_id, found.id, reader)
                        .await?
                {
                    return Ok(Err(ActionRejection::new(OWNER_CANNOT_SEE)));
                }
            }
            let Some(found_members) =
                resolve_member_handles_in_tx(conn, workspace_id, handles).await?
            else {
                return Ok(Err(ActionRejection::new("member handle did not resolve")));
            };
            let ids: Vec<Uuid> = found_members.iter().map(|member| member.id).collect();
            *already_in = momo_db::sqlx::query_scalar(
                "SELECT member_id FROM membership \
                  WHERE workspace_id = $1 AND channel_id = $2 AND left_at IS NULL \
                    AND member_id = ANY($3)",
            )
            .bind(workspace_id)
            .bind(found.id)
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await?;
            let new_names: Vec<String> = found_members
                .iter()
                .filter(|member| !already_in.contains(&member.id))
                .map(ResolvedMember::card_label)
                .collect();
            if new_names.is_empty() {
                // Everyone named is already in: nothing to approve.
                return Ok(Err(ActionRejection::new("no member to add")));
            }
            validated.rows = actions::channel_member_add_rows(
                &found.name,
                &found.kind,
                found.member_count,
                &new_names,
                already_in.len(),
            );
            *channel = Some(found);
            *members = found_members;
            GateSubject::Workspace
        }
    };
    let pins = match &validated.args {
        ActionArgs::WorkspaceSettingsUpdate { before, .. } => json!({
            "welcome_prompt": before.welcome_prompt,
            "role_labels": before.role_labels,
        }),
        ActionArgs::HostedChannelsGrant {
            connection,
            channels,
            ..
        } => json!({
            "connection": connection.as_ref().map(|c| c.id.to_string()),
            "channels": channels.iter().map(|c| c.id.to_string()).collect::<Vec<_>>(),
        }),
        ActionArgs::AgentRename { target, .. } => json!({
            "target": target.as_ref().map(|target| target.id.to_string()),
        }),
        ActionArgs::AgentProfileUpdate {
            target,
            before,
            avatar,
            ..
        } => json!({
            "target": target.as_ref().map(|target| target.id.to_string()),
            // What the card said 「현재」 was: a change in between re-asks.
            "name": target.as_ref().map(|target| target.current_display_name.clone()),
            "card": before.as_ref().map(|card| json!({
                "tagline": card.tagline,
                "roleLabel": card.role_label,
                "statusEmoji": card.status_emoji,
                "statusText": card.status_text,
                "avatarPreset": card.avatar_preset,
                "avatarImage": card.avatar_image_id.map(|id| id.to_string()),
            })),
            "avatar": avatar_pin(avatar),
        }),
        // The person the run was raised by and the picture they were shown. What the
        // card said 「현재」 was is deliberately not pinned: the person may have changed
        // their own picture meanwhile and still be approving the one they were shown.
        ActionArgs::MemberAvatarSet { avatar, target } => json!({
            "target": target.as_ref().map(|person| person.id.to_string()),
            "avatar": avatar_pin(avatar),
        }),
        ActionArgs::InviteCreate { .. } => Value::Null,
        // What the card said 「현재」 was: a switch flipped in between re-asks.
        ActionArgs::WorkspaceUnfurlUpdate { before, .. } => json!({"enabled": before}),
        ActionArgs::WorkspaceMemoryUpdate { .. } => Value::Null,
        ActionArgs::WorkspaceWorkTierUpdate { before, .. } => json!({
            "mode": before.as_ref().map(|(mode, _)| mode.clone()),
            "autoTarget": before.as_ref().and_then(|(_, target)| target.clone()),
        }),
        // What the card said the app was and reached: a manifest that changed, or an
        // install that moved, in between re-asks.
        ActionArgs::PluginInstall { plugin_id, plugin } => json!({
            "pluginId": plugin_id,
            "digest": plugin.as_ref().map(|plugin| plugin.digest.clone()),
            "before": plugin.as_ref().map(|plugin| plugin.before.as_pin()),
        }),
        ActionArgs::AgentInvite { handle, .. } => json!({"handle": handle}),
        ActionArgs::ChannelCreate { members, .. } => {
            json!({"members": members.iter().map(|m| m.id.to_string()).collect::<Vec<_>>()})
        }
        ActionArgs::ChannelMemberAdd {
            channel, members, ..
        } => json!({
            "channel": channel.as_ref().map(|c| c.id.to_string()),
            "members": members.iter().map(|m| m.id.to_string()).collect::<Vec<_>>(),
        }),
        // The message, its channel and a hash of the words the approver read: an edit, a delete
        // or a move in between re-asks. (`message`, not `target`: `pins.target` is read as a
        // member id elsewhere — `decider::pinned_target_agent`.)
        ActionArgs::MessagePin { target, .. } => json!({
            "message": target.as_ref().map(|t| t.id.to_string()),
            "channel": target.as_ref().map(|t| t.channel_id.to_string()),
            "bodySha256": target.as_ref().map(|t| t.body_sha256.clone()),
        }),
    };
    Ok(Ok(ResolvedAction {
        validated,
        subject,
        pins,
    }))
}

/// One optional integer argument, inside the ceilings the registry publishes.
///
/// `as_i64` also refuses a fractional or float-shaped number, which `integer`
/// forbids and a lenient reader would have truncated.
pub fn bounded_integer(
    object: &serde_json::Map<String, Value>,
    key: &str,
    minimum: i64,
    maximum: i64,
) -> Result<Option<i64>, ActionRejection> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => {
            let value = number
                .as_i64()
                .filter(|_| number.is_i64())
                .ok_or_else(|| ActionRejection::new("argument must be an integer"))?;
            if !(minimum..=maximum).contains(&value) {
                return Err(ActionRejection::new("argument is out of range"));
            }
            Ok(Some(value))
        }
        Some(_) => Err(ActionRejection::new("argument must be an integer")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `message.pin` / `message.unpin` (ADR-0186 증보 v5 U-e): the proposal is one message id
    /// and nothing else — no channel, no link, no text can be spelled — and the id is stored in
    /// its one canonical spelling, so the pin's comparison cannot be defeated by writing it
    /// another way.
    #[test]
    fn message_pin_is_one_message_id_and_names_nothing_else() {
        let id = Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
        for (action_id, change) in [
            (actions::ACTION_MESSAGE_PIN, PinAction::Pinned),
            (actions::ACTION_MESSAGE_UNPIN, PinAction::Unpinned),
        ] {
            let action = actions::action_by_id(action_id).expect("registered");
            // The two ids reach the right variant through the one dispatcher.
            let ok = validated_action_args(action, &json!({"messageId": id.to_string()}), 0)
                .expect("a message id");
            assert_eq!(ok.normalized, json!({"messageId": id.to_string()}));
            assert!(
                ok.rows.is_empty(),
                "the rows are the server's reading of the message"
            );
            assert!(matches!(
                ok.args,
                ActionArgs::MessagePin { message_id, change: found, target: None }
                    if message_id == id && found == change
            ));
            // An upper-case id is the same id, stored lower-case.
            let upper = validated_action_args(
                action,
                &json!({"messageId": id.to_string().to_uppercase()}),
                0,
            )
            .expect("the same id");
            assert_eq!(upper.normalized, ok.normalized);

            for bad in [
                json!({}),
                json!({"messageId": null}),
                json!({"messageId": 7}),
                json!({"messageId": "not-a-uuid"}),
                // Other spellings of an id are not what `oort_conversation_read` gives.
                json!({"messageId": id.simple().to_string()}),
                json!({"messageId": format!("urn:uuid:{id}")}),
                json!({"messageId": format!("{{{id}}}")}),
                // Where, what, or whose — spelled every way the other actions spell them.
                json!({"messageId": id.to_string(), "channel": "general"}),
                json!({"messageId": id.to_string(), "channelId": Uuid::nil().to_string()}),
                json!({"messageId": id.to_string(), "body": "hi"}),
                json!({"messageId": id.to_string(), "url": "https://evil.example/"}),
                json!({"messageId": id.to_string(), "target": Uuid::nil().to_string()}),
                json!(["messageId"]),
                json!(null),
            ] {
                assert!(
                    validated_action_args(action, &bad, 0).is_err(),
                    "{action_id} must refuse {bad}"
                );
            }
        }
    }

    /// `member.avatar.set` (ADR-0186 증보 v4): the proposal is the attachment id and
    /// nothing else. Every spelling of "who", "from where" or "what bytes" is refused —
    /// the person is derived from the run, never named.
    #[test]
    fn member_avatar_set_proposal_is_one_attachment_id_and_names_no_person() {
        let id = Uuid::from_u128(0x0190_d3a0_0000_7000_8000_0000_0000_0001);
        let ok = member_avatar_set_args(
            &json!({ "attachmentId": id.to_string() }),
            ArgsOrigin::Proposal,
        )
        .expect("a proposal");
        assert_eq!(ok.normalized, json!({"avatar": {"source": "attachment"}}));
        assert!(
            !ok.normalized.to_string().contains(&id.to_string()),
            "the attachment id never reaches the stored form"
        );
        assert!(matches!(
            ok.args,
            ActionArgs::MemberAvatarSet {
                avatar: AvatarIntent::Attachment(found),
                target: None,
            } if found == id
        ));
        let some_member = Uuid::from_u128(9).to_string();
        for bad in [
            json!({}),
            json!({"attachmentId": null}),
            json!({"attachmentId": 7}),
            json!({"attachmentId": "not-a-uuid"}),
            json!({"attachmentId": "A".repeat(37)}),
            // Whose picture, spelled every way the other actions spell a target.
            json!({"attachmentId": id.to_string(), "memberId": some_member}),
            json!({"attachmentId": id.to_string(), "targetHandle": "someone"}),
            json!({"attachmentId": id.to_string(), "target": some_member}),
            json!({"attachmentId": id.to_string(), "forMemberId": some_member}),
            // What picture, spelled as the agent's own avatar forms.
            json!({"attachmentId": id.to_string(), "url": "https://evil.example/x.png"}),
            json!({"attachmentId": id.to_string(), "dataBase64": "AAAA"}),
            json!({"attachmentId": id.to_string(), "presetId": "comet"}),
            json!({"avatar": {"source": "attachment", "attachmentId": id.to_string()}}),
            json!({"avatar": {"source": "staged", "imageId": id.to_string(),
                              "sha256": "0".repeat(64), "origin": "attachment"}}),
            json!(id.to_string()),
            json!([id.to_string()]),
        ] {
            assert!(
                member_avatar_set_args(&bad, ArgsOrigin::Proposal).is_err(),
                "{bad}"
            );
        }
    }

    /// The **stored** form is only ever the server's `staged` shape: a raw
    /// `attachmentId` is a proposal's, and a row that carries one has been tampered with.
    #[test]
    fn member_avatar_set_stored_form_is_only_the_staged_image() {
        let id = Uuid::from_u128(0x0190_d3a0_0000_7000_8000_0000_0000_0002);
        let sha = "ab".repeat(32);
        let staged = json!({"avatar": {"source": "staged", "imageId": id.to_string(),
                                        "sha256": sha, "origin": "attachment"}});
        let parsed = member_avatar_set_args(&staged, ArgsOrigin::Stored).expect("stored");
        assert_eq!(parsed.normalized, staged);
        assert_eq!(
            avatar_pin(match &parsed.args {
                ActionArgs::MemberAvatarSet { avatar, .. } => avatar,
                other => panic!("{other:?}"),
            }),
            json!({"imageId": id.to_string(), "sha256": sha})
        );
        for bad in [
            json!({"attachmentId": id.to_string()}),
            json!({"avatar": {"source": "attachment", "attachmentId": id.to_string()}}),
            json!({"avatar": {"source": "generated", "dataBase64": "AAAA"}}),
            json!({"avatar": {"source": "preset", "presetId": "comet"}}),
            json!({"avatar": null}),
            json!({"avatar": {"source": "staged", "imageId": id.to_string(),
                              "sha256": sha, "origin": "url"}}),
            json!({"avatar": {"source": "staged", "imageId": id.to_string(),
                              "sha256": sha, "origin": "attachment", "bytes": "AA"}}),
            json!({"avatar": {"source": "staged", "imageId": id.to_string(),
                              "sha256": sha, "origin": "attachment"}, "memberId": id.to_string()}),
            json!({}),
        ] {
            assert!(
                member_avatar_set_args(&bad, ArgsOrigin::Stored).is_err(),
                "{bad}"
            );
        }
    }

    /// `plugin.install` (H7, #3889): the pure stage takes exactly the official four
    /// by id and keeps the static table's own string; everything else is refused
    /// and the refusal names nothing the caller typed.
    #[test]
    fn plugin_install_takes_exactly_one_official_id() {
        for (id, _) in actions::PLUGIN_INSTALL_PLUGINS {
            let validated = plugin_install_args(&json!({ "pluginId": id })).expect(id);
            assert_eq!(validated.normalized, json!({ "pluginId": id }));
            assert!(
                validated.rows.is_empty(),
                "the rows come from the resolver, which reads the manifest"
            );
            assert!(matches!(
                validated.args,
                ActionArgs::PluginInstall { plugin: None, .. }
            ));
        }
        let marker = "sk-live-must-not-echo";
        for bad in [
            json!({}),
            json!({ "pluginId": 7 }),
            json!({ "pluginId": null }),
            json!({ "pluginId": "external_webhook" }),
            json!({ "pluginId": marker }),
            json!({ "pluginId": "com.momo.plugins.github", "enabled": true }),
            json!({ "pluginId": "com.momo.plugins.github", "accessToken": marker }),
            json!("com.momo.plugins.github"),
            json!(["com.momo.plugins.github"]),
        ] {
            let error = plugin_install_args(&bad).expect_err("refused");
            assert_eq!(error.status, 400, "{bad}");
            assert!(!error.message.contains(marker), "{error:?}");
        }
    }

    /// A card is where registry text becomes a consent: it prints a version only if
    /// it looks like one and a domain only if it looks like one. Anything else makes
    /// the proposal not resolve (the install itself re-runs the full manifest
    /// admission).
    #[test]
    fn a_card_prints_only_a_plausible_version_and_plausible_domains() {
        let long_version = "a".repeat(33);
        for ok in ["1.0.0", "2026.10.16", "1.0.0-rc.1+build_5"] {
            assert!(plausible_version(ok), "{ok}");
        }
        for bad in ["", " 1.0", "1.0 <b>", "한글", "1\n0", long_version.as_str()] {
            assert!(!plausible_version(bad), "{bad:?}");
        }
        let long_domain = format!("{}.com", "a".repeat(250));
        for ok in [
            "api.githubcopilot.com",
            "mcp.notion.com",
            "www.googleapis.com",
            "xn--abc.example.com",
        ] {
            assert!(plausible_egress_domain(ok), "{ok}");
        }
        for bad in [
            "",
            "localhost",
            "-a.com",
            "a.com-",
            ".a.com",
            "a.com.",
            "API.github.com",
            "evil.com/path",
            "a b.com",
            "a.com\n",
            "https://a.com",
            "a.com@b.com",
            long_domain.as_str(),
        ] {
            assert!(!plausible_egress_domain(bad), "{bad:?}");
        }
    }
}
