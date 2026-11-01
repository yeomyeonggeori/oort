//! The team AI's **role bundles** — which kinds of work the workspace's helper
//! ("oort 도우미") may be asked to do (ADR-0201 증보 v3 B3, #4964 S1).
//!
//! A bundle is a *wall*, not a prompt hint (B13-I5): while it is off, what it owns is
//!
//! 1. **not advertised** — the request's tool list and the `actionId` enum are built from the
//!    workspace's settings on every request ([`TeamAiRoles::advertised_action_ids`]); the
//!    system prompt carries no sentence for it;
//! 2. **refused when proposed** — the proposal transaction re-reads the settings;
//! 3. **refused when approved** — the decision route re-reads them for a card the helper
//!    raised, so a card that was drawn while the bundle was on (or that came in sideways)
//!    does not run once it is off.
//!
//! ## The table
//!
//! [`BUNDLES`] is the one place that says what each bundle owns. `workspace_admin` owns the
//! eleven cards of ADR-0201 증보 v2 F2, `invite_access` owns `invite.create` and `agent.invite`
//! (S2, #4965), `long_research` owns the task-mode tool `task_continue` (S4, #4967), `files` owns
//! its one tool (`read_attachment`, #4970 S7) and `code` owns the work-request card
//! (`card_suggest`'s `work.request.open`, #4972 S9); the others are empty slots, so a later slice
//! (S8 memory) adds an id to its row and nothing else: the filters below read the table.
//! `team_ai.roles.set` itself belongs to **no** bundle — if it did, switching
//! `workspace_admin` off would also remove the only chat path back on.
//!
//! ## Defaults
//!
//! Every bundle is **on** (owner answer 2026-11-01): a missing `team_ai_roles` key, a missing
//! field and a workspace that never opened the settings all read as on. The reader fails the
//! other way for a value that is *present but not a boolean*: that bundle reads as **off**
//! (the settings PATCH refuses such a value, so it can only come from outside the API, and a
//! switch somebody meant to set must not silently become "on"). `chat_read` is not a field at
//! all: it is always on and no stored value can change that.

use serde_json::Value;

use crate::actions::{
    ACTION_AGENT_INVITE, ACTION_AGENT_PROFILE_UPDATE, ACTION_AGENT_RENAME, ACTION_CHANNEL_CREATE,
    ACTION_CHANNEL_MEMBER_ADD, ACTION_HOST_SESSION_OPEN, ACTION_INVITE_CREATE,
    ACTION_MEMBER_AVATAR_SET, ACTION_MEMBER_DISPLAY_NAME_SET, ACTION_MEMBER_ROLE_SET,
    ACTION_PLUGIN_INSTALL, ACTION_TEAM_AI_ROLES_SET, ACTION_WORKSPACE_MEMORY_UPDATE,
    ACTION_WORKSPACE_SETTINGS_UPDATE, ACTION_WORKSPACE_UNFURL_UPDATE,
    ACTION_WORKSPACE_WORK_TIER_UPDATE, TEAM_AI_ACTION_IDS,
};
use crate::card_suggest::{COMMAND_WORK_REQUEST_OPEN, TEAM_AI_SUGGESTABLE_COMMAND_IDS};
use crate::tools::TASK_CONTINUE;

/// The workspace settings key that holds the switches (an object of booleans).
pub const SETTINGS_KEY: &str = "team_ai_roles";

/// 대화·읽기 — conversation, the requester-scoped reads, web search. **Not a settings field**:
/// always on, refused as an argument of `team_ai.roles.set`, ignored if found in storage.
pub const CHAT_READ: &str = "chat_read";
pub const WORKSPACE_ADMIN: &str = "workspace_admin";
pub const INVITE_ACCESS: &str = "invite_access";
pub const LONG_RESEARCH: &str = "long_research";
pub const FILES: &str = "files";
pub const MEMORY: &str = "memory";
pub const CODE: &str = "code";

/// The one tool the `files` bundle owns (ADR-0201 증보 v3 B6-1, #4970 S7): the helper reads an
/// attachment of the person who asked. Offered only while `files` is on ([`TeamAiRoles::tool_allowed`]),
/// and refused at execution when it is off (B13-I5).
pub const TOOL_READ_ATTACHMENT: &str = "read_attachment";

/// The six switchable bundle ids, in the ADR's table order. `momo-settings` cannot see this
/// crate, so it keeps its own copy of the six (`TEAM_AI_ROLES_KEYS`) and a drift test in
/// `momo-workspace-actions` holds the two equal.
pub const SWITCHABLE_BUNDLES: [&str; 6] = [
    WORKSPACE_ADMIN,
    INVITE_ACCESS,
    LONG_RESEARCH,
    FILES,
    MEMORY,
    CODE,
];

/// What the 「어떤 내용이 팀 AI 공급자에게 가는지」 line was worded as, when an admin read it.
/// **Bump this when either notice below changes**: the consent record names this value, and a
/// record that quotes an old version says the admin did not read the new words.
pub const NOTICE_VERSION: &str = "2026-11-01.v1";

const NOTICE_FILES: &str =
    "파일을 켜면 도우미가 읽은 첨부 파일의 내용이 팀 AI 공급자(팀 키를 발급한 AI 회사)에게 전달돼요.";
const NOTICE_MEMORY: &str =
    "기억을 켜면 도우미가 찾은 팀 기억의 내용이 팀 AI 공급자(팀 키를 발급한 AI 회사)에게 전달돼요.";

/// One bundle and what it owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoleBundle {
    pub id: &'static str,
    /// The name the card and the model use (해요체 sentences put a particle after it).
    pub label: &'static str,
    /// `workspace_action_propose` ids this bundle owns. Not advertised, not proposable and not
    /// executable while the bundle is off.
    pub action_ids: &'static [&'static str],
    /// Other tools this bundle owns (a later slice's `task_continue`, `read_attachment`,
    /// `search_memory`, …). Dropped from the request's tool list while the bundle is off.
    pub tool_names: &'static [&'static str],
    /// `card_suggest` command ids this bundle owns (ADR-0201 v3 B8 C1: `code` owns
    /// `work.request.open`). The helper's `card_suggest` is one tool that carries several
    /// commands, so the wall is per **command**, not per tool name: while the bundle is off its
    /// ids are not on the tool's `commandId` enum, have no sentence in the prompt, and a suggestion
    /// that names one is refused — and a bundle going off never takes a command it does not own
    /// (`settings.open`, if the helper gets it, belongs to no bundle) down with it.
    pub command_ids: &'static [&'static str],
    /// Turning the bundle **on** sends this kind of content to the team's AI provider (B3
    /// 고지). The card that turns it on shows this line, and approving it is the consent.
    pub notice: Option<&'static str>,
}

/// The table. Order is the settings object's field order.
pub const BUNDLES: [RoleBundle; 6] = [
    RoleBundle {
        id: WORKSPACE_ADMIN,
        label: "워크스페이스 관리",
        action_ids: &[
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
        ],
        tool_names: &[],
        command_ids: &[],
        notice: None,
    },
    // `TEAM_AI_ACTION_IDS` carries both since S2 (#4965). `member.role.set` joins this row when
    // its executor exists (B4-5); it is on the sensitive list already.
    RoleBundle {
        id: INVITE_ACCESS,
        label: "초대·권한",
        action_ids: &[ACTION_INVITE_CREATE, ACTION_AGENT_INVITE],
        tool_names: &[],
        command_ids: &[],
        notice: None,
    },
    // S4 (#4967): the task-mode tool. It leaves the request's tool list with the bundle
    // (`tool_allowed`), and a call of it that was never offered is refused by the worker.
    RoleBundle {
        id: LONG_RESEARCH,
        label: "긴 조사",
        action_ids: &[],
        tool_names: &[TASK_CONTINUE],
        command_ids: &[],
        notice: None,
    },
    RoleBundle {
        id: FILES,
        label: "파일",
        action_ids: &[],
        tool_names: &[TOOL_READ_ATTACHMENT],
        command_ids: &[],
        notice: Some(NOTICE_FILES),
    },
    RoleBundle {
        id: MEMORY,
        label: "기억",
        action_ids: &[],
        tool_names: &[],
        command_ids: &[],
        notice: Some(NOTICE_MEMORY),
    },
    RoleBundle {
        id: CODE,
        label: "코드",
        action_ids: &[],
        tool_names: &[],
        // #4972 (S9): the one card the helper gives for coding work — it opens the person's own
        // 「작업 요청」 sheet, filled in. The box (S10, ADR-0210 증보) is a later tool.
        command_ids: &[COMMAND_WORK_REQUEST_OPEN],
        notice: None,
    },
];

/// B4-3 오염 규칙: once a request's model context holds anything it **read** — a workspace read
/// tool's result or a web search's (later: a file, a memory, a box result) — these ids leave the
/// `actionId` enum and the prompt sentences of every later call, a proposal of one is refused, and
/// a card of one that does not say its request read nothing is refused at the decision. A person
/// who asks directly (no read in the request) still gets the card.
///
/// Five ids, by what a card of each one hands out: an invite link and an agent's pairing code
/// (`invite.create`, `agent.invite`), a person's workspace role (`member.role.set`, not
/// executable yet), a session on the team's box (`host.session.open`, ADR-0210, not in the
/// registry yet) and the helper's own reach (`team_ai.roles.set`, S1). The two that do not exist
/// yet are named so the day one is opened it is already covered — a deny-list can name an id before
/// the action exists, an allow-list cannot.
pub const SENSITIVE_ACTION_IDS: [&str; 5] = [
    ACTION_INVITE_CREATE,
    ACTION_AGENT_INVITE,
    ACTION_MEMBER_ROLE_SET,
    ACTION_HOST_SESSION_OPEN,
    ACTION_TEAM_AI_ROLES_SET,
];

/// The bundle `id` names, or `None` (including for [`CHAT_READ`], which is not switchable).
pub fn bundle(id: &str) -> Option<&'static RoleBundle> {
    BUNDLES.iter().find(|bundle| bundle.id == id)
}

/// The bundle that owns this action id, or `None` for an id no bundle owns
/// (`team_ai.roles.set` is the one such id the helper may propose).
pub fn bundle_of_action(action_id: &str) -> Option<&'static RoleBundle> {
    BUNDLES
        .iter()
        .find(|bundle| bundle.action_ids.contains(&action_id))
}

/// The bundle that owns this `card_suggest` command id, or `None` for a command no bundle owns.
pub fn bundle_of_command(command_id: &str) -> Option<&'static RoleBundle> {
    BUNDLES
        .iter()
        .find(|bundle| bundle.command_ids.contains(&command_id))
}

/// Is this id one the oort 도우미 may not propose once it has read something?
pub fn is_sensitive_action(action_id: &str) -> bool {
    SENSITIVE_ACTION_IDS.contains(&action_id)
}

/// The notice line for turning `bundle_id` **on**, if it has one.
pub fn notice_for(bundle_id: &str) -> Option<&'static str> {
    bundle(bundle_id).and_then(|bundle| bundle.notice)
}

/// Which switchable bundles are on. `Copy` and tiny: it rides in `TeamAiWorkspace`, which the
/// worker reads once per request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TeamAiRoles {
    /// Bit `i` set = `BUNDLES[i]` is **off**. All zero = everything on (the default).
    off: u8,
}

impl TeamAiRoles {
    /// Read the switches from a `workspace.settings` bag: an absent key or field is on, a
    /// literal `false` is off, and anything else that is *present* (not a boolean) is off.
    pub fn from_settings(settings: &Value) -> Self {
        Self::from_value(settings.get(SETTINGS_KEY))
    }

    /// [`Self::from_settings`] for the `team_ai_roles` value itself.
    pub fn from_value(value: Option<&Value>) -> Self {
        let mut roles = TeamAiRoles::default();
        match value {
            None | Some(Value::Null) => {}
            Some(Value::Object(fields)) => {
                for (index, bundle) in BUNDLES.iter().enumerate() {
                    match fields.get(bundle.id) {
                        None | Some(Value::Null) | Some(Value::Bool(true)) => {}
                        Some(_) => roles.off |= 1 << index,
                    }
                }
            }
            // Not an object at all: the switches are unreadable, so none of them is "on".
            Some(_) => roles.off = (1u8 << BUNDLES.len()) - 1,
        }
        roles
    }

    /// Every switch off. What a reader answers with when it could not read the settings and the
    /// answer decides a *refusal* (the decision route): unreadable never reads as "on".
    pub const fn none_on() -> Self {
        TeamAiRoles {
            off: (1u8 << BUNDLES.len()) - 1,
        }
    }

    /// Is this bundle on? [`CHAT_READ`] is always on; an id that is not a bundle is **not**.
    pub fn is_on(&self, bundle_id: &str) -> bool {
        if bundle_id == CHAT_READ {
            return true;
        }
        match BUNDLES.iter().position(|bundle| bundle.id == bundle_id) {
            Some(index) => self.off & (1 << index) == 0,
            None => false,
        }
    }

    /// The same switches with one bundle set (an unknown id changes nothing).
    pub fn with(mut self, bundle_id: &str, enabled: bool) -> Self {
        if let Some(index) = BUNDLES.iter().position(|bundle| bundle.id == bundle_id) {
            if enabled {
                self.off &= !(1 << index);
            } else {
                self.off |= 1 << index;
            }
        }
        self
    }

    /// May the helper's proposal name this action id right now? An id no bundle owns is not
    /// bundle-gated (the allow-list, [`TEAM_AI_ACTION_IDS`], is a separate check).
    pub fn action_allowed(&self, action_id: &str) -> bool {
        match bundle_of_action(action_id) {
            Some(bundle) => self.is_on(bundle.id),
            None => true,
        }
    }

    /// May this tool be offered right now? A tool no bundle owns (the reads, the proposal tool
    /// itself) is not bundle-gated.
    pub fn tool_allowed(&self, tool_name: &str) -> bool {
        tool_allowed_in(&BUNDLES, self, tool_name)
    }

    /// The `actionId`s one model call may be offered: the allow-list, minus the ids of every
    /// bundle that is off, minus [`SENSITIVE_ACTION_IDS`] when the request has `read`
    /// something (`tainted`). Catalog order. **The one function the tool schema, the system
    /// prompt and the proposal check all read**, so they cannot disagree.
    pub fn advertised_action_ids(&self, tainted: bool) -> Vec<&'static str> {
        TEAM_AI_ACTION_IDS
            .iter()
            .copied()
            .filter(|id| self.action_allowed(id))
            .filter(|id| !(tainted && is_sensitive_action(id)))
            .collect()
    }

    /// What a read takes away from a request whose bundles are these: the ids it would be offered
    /// if it had read nothing and is not offered now that it has (B4-3) — the sensitive ids of the
    /// bundles that are on. The system prompt of a later call names them as withheld, so the
    /// model is told what to say instead of being left to guess.
    pub fn withheld_by_read(&self) -> Vec<&'static str> {
        self.advertised_action_ids(false)
            .into_iter()
            .filter(|id| is_sensitive_action(id))
            .collect()
    }

    /// May the helper's `card_suggest` name this command right now? A command no bundle owns is
    /// not bundle-gated (the helper allow-list, [`TEAM_AI_SUGGESTABLE_COMMAND_IDS`], is a separate
    /// check).
    pub fn command_allowed(&self, command_id: &str) -> bool {
        match bundle_of_command(command_id) {
            Some(bundle) => self.is_on(bundle.id),
            None => true,
        }
    }

    /// The `commandId`s the helper's `card_suggest` may be offered: the helper allow-list minus the
    /// ids of every bundle that is off. Empty means the tool is not offered at all. **The one
    /// function the tool schema, the system prompt and the suggestion check all read**, like
    /// [`Self::advertised_action_ids`] for the proposal tool, so they cannot disagree.
    pub fn advertised_command_ids(&self) -> Vec<&'static str> {
        TEAM_AI_SUGGESTABLE_COMMAND_IDS
            .iter()
            .copied()
            .filter(|id| self.command_allowed(id))
            .collect()
    }

    /// The bundle ids that are off, in table order.
    pub fn off_bundles(&self) -> Vec<&'static str> {
        BUNDLES
            .iter()
            .filter(|bundle| !self.is_on(bundle.id))
            .map(|bundle| bundle.id)
            .collect()
    }
}

/// [`TeamAiRoles::tool_allowed`] over any table, so the seam later slices fill is testable
/// before any of them lands.
fn tool_allowed_in(table: &[RoleBundle], roles: &TeamAiRoles, tool_name: &str) -> bool {
    table
        .iter()
        .filter(|bundle| bundle.tool_names.contains(&tool_name))
        .all(|bundle| roles.is_on(bundle.id))
}

/// The names in `table`'s `tool_names` that none of `known` carries. A name nobody carries is a
/// bundle that filters nothing — the tool it meant would stay on offer while the bundle is off,
/// and nothing would say so — so a misspelt name must fail a test rather than read as "no such
/// tool is offered". The caller supplies every tool the helper can be offered.
pub fn unknown_tool_names<'a>(table: &'a [RoleBundle], known: &[&str]) -> Vec<&'a str> {
    table
        .iter()
        .flat_map(|bundle| bundle.tool_names.iter().copied())
        .filter(|name| !known.contains(name))
        .collect()
}

/// The command ids in `table` that are not on the helper allow-list
/// ([`TEAM_AI_SUGGESTABLE_COMMAND_IDS`]). Same reason as [`unknown_tool_names`]: an id nobody
/// offers is a bundle that filters nothing, so a misspelling must fail a test instead of reading
/// as "no such command is offered".
pub fn unknown_command_ids(table: &[RoleBundle]) -> Vec<&'static str> {
    table
        .iter()
        .flat_map(|bundle| bundle.command_ids.iter().copied())
        .filter(|id| !TEAM_AI_SUGGESTABLE_COMMAND_IDS.contains(id))
        .collect()
}

// ---------------------------------------------------------------------------
// the card (B3-T)
// ---------------------------------------------------------------------------

/// `audit_log.action` of a change to the switches (key **names** only, never values — the
/// card the approver read shows the direction).
pub const AUDIT_ROLES_CHANGED: &str = "team_ai.roles.changed";
pub const AUDIT_ROLES_CHANGED_SCHEMA: &str = "momo.team_ai.roles.changed.v1";

/// `audit_log.action` of an admin having been shown the 「공급자로 가는 내용」 line for the
/// bundles in the detail: who (actor), when (the row's time), which wording
/// ([`NOTICE_VERSION`]). The existing audit trail is the record; there is no table.
pub const AUDIT_ROLES_NOTICE: &str = "team_ai.roles.notice_shown";
pub const AUDIT_ROLES_NOTICE_SCHEMA: &str = "momo.team_ai.roles.notice_shown.v1";

fn on_off(on: bool) -> &'static str {
    if on {
        "켜짐"
    } else {
        "꺼짐"
    }
}

/// The card's rows: the bundle and the switch (`파일 · 꺼짐 → 켜짐`), plus — only when a
/// bundle with a notice is being turned **on** — the line that says what goes to the provider.
pub fn roles_set_rows(bundle: &RoleBundle, before: bool, after: bool) -> Vec<Value> {
    let mut rows = vec![crate::actions::action_row(
        "도우미 역할",
        format!("{} · {} → {}", bundle.label, on_off(before), on_off(after)),
    )];
    if after {
        if let Some(notice) = bundle.notice {
            rows.push(crate::actions::action_row("공급자로 가는 내용", notice));
        }
    }
    rows
}

/// The outcome line.
pub fn roles_set_result_body(bundle: &RoleBundle, after: bool) -> String {
    format!(
        "도우미의 {} 역할을 {}어요",
        bundle.label,
        if after { "켰" } else { "껐" }
    )
}

/// The outcome card's rows: what the switch was and is now.
pub fn roles_set_result_rows(bundle: &RoleBundle, before: bool, after: bool) -> Vec<Value> {
    vec![crate::actions::action_row(
        "도우미 역할",
        format!("{} · {} → {}", bundle.label, on_off(before), on_off(after)),
    )]
}

/// The role table the system prompt shows the model so 「파일 역할 꺼 줘」 maps to an id.
/// Names only — no word about what a bundle lets the helper do, so a bundle that is off
/// leaves no guidance in the prompt (B15-A16).
pub fn prompt_role_table() -> String {
    BUNDLES
        .iter()
        .map(|bundle| format!("{}={}", bundle.id, bundle.label))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn off(ids: &[&str]) -> TeamAiRoles {
        ids.iter()
            .fold(TeamAiRoles::default(), |roles, id| roles.with(id, false))
    }

    /// Owner answer 2026-11-01 (Q2 B): nothing stored means seven bundles on.
    #[test]
    fn nothing_stored_reads_as_every_bundle_on() {
        for settings in [
            json!({}),
            json!({"role_labels": {"owner": "대표"}}),
            json!({"team_ai_roles": null}),
            json!({"team_ai_roles": {}}),
        ] {
            let roles = TeamAiRoles::from_settings(&settings);
            assert_eq!(roles, TeamAiRoles::default(), "{settings}");
            assert!(roles.off_bundles().is_empty(), "{settings}");
            for id in SWITCHABLE_BUNDLES {
                assert!(roles.is_on(id), "{id} {settings}");
            }
            assert!(roles.is_on(CHAT_READ));
        }
        // A missing field is on; only the field that is `false` is off.
        let roles = TeamAiRoles::from_settings(&json!({"team_ai_roles": {"files": false}}));
        assert_eq!(roles.off_bundles(), [FILES]);
    }

    /// A value that is present but not a boolean never reads as "on", and `chat_read` is not a
    /// field: no stored value turns it off, and an id that is not a bundle is not on.
    #[test]
    fn a_present_value_that_is_not_true_fails_closed_and_chat_read_cannot_be_stored_off() {
        for bad in [json!("true"), json!(1), json!([]), json!({}), json!(false)] {
            let roles = TeamAiRoles::from_settings(&json!({"team_ai_roles": {"memory": bad}}));
            assert!(!roles.is_on(MEMORY), "{bad}");
            assert!(roles.is_on(FILES), "{bad}");
        }
        let roles = TeamAiRoles::from_settings(&json!({"team_ai_roles": "everything"}));
        assert!(!roles.is_on(WORKSPACE_ADMIN));
        assert!(roles.is_on(CHAT_READ));
        let stored_off =
            TeamAiRoles::from_settings(&json!({"team_ai_roles": {"chat_read": false}}));
        assert!(stored_off.is_on(CHAT_READ));
        assert_eq!(stored_off, TeamAiRoles::default());
        assert!(!TeamAiRoles::default().is_on("no_such_bundle"));
    }

    /// The table is closed: every id the helper may propose is owned by exactly one bundle or is
    /// the card that switches the bundles; no bundle claims an id the registry does not carry;
    /// no id has two owners. This is what stops a later slice adding an id that no switch can
    /// turn off.
    #[test]
    fn every_team_ai_id_has_one_owner_or_is_the_roles_card() {
        for id in TEAM_AI_ACTION_IDS {
            let owners = BUNDLES
                .iter()
                .filter(|bundle| bundle.action_ids.contains(&id))
                .count();
            if id == ACTION_TEAM_AI_ROLES_SET {
                assert_eq!(owners, 0, "the roles card must not be gated by a bundle");
            } else {
                assert_eq!(owners, 1, "{id} needs exactly one owning bundle");
            }
        }
        for bundle in BUNDLES {
            for id in bundle.action_ids {
                assert!(
                    crate::actions::action_by_id(id).is_some(),
                    "{} names {id}, which the registry does not carry",
                    bundle.id
                );
            }
        }
        let mut ids: Vec<&str> = BUNDLES.iter().map(|bundle| bundle.id).collect();
        assert_eq!(ids, SWITCHABLE_BUNDLES);
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 6);
        assert!(bundle(CHAT_READ).is_none(), "chat_read is not a bundle row");
    }

    /// The filter every consumer reads: eleven + the two invites + the roles card by default; a
    /// bundle that is off takes its ids out and nothing else; the roles card stays while
    /// `workspace_admin` is off.
    #[test]
    fn advertised_ids_follow_the_switches() {
        let all = TeamAiRoles::default().advertised_action_ids(false);
        assert_eq!(all, TEAM_AI_ACTION_IDS);
        assert_eq!(all.len(), 14);

        let no_admin = off(&[WORKSPACE_ADMIN]).advertised_action_ids(false);
        assert_eq!(
            no_admin,
            [
                ACTION_INVITE_CREATE,
                ACTION_AGENT_INVITE,
                ACTION_TEAM_AI_ROLES_SET
            ]
        );

        // B3 / B4: `invite_access` off takes the two invite ids and nothing else out.
        let no_invites = off(&[INVITE_ACCESS]).advertised_action_ids(false);
        assert_eq!(no_invites.len(), 12);
        assert!(!no_invites.contains(&ACTION_INVITE_CREATE));
        assert!(!no_invites.contains(&ACTION_AGENT_INVITE));
        assert!(no_invites.contains(&ACTION_TEAM_AI_ROLES_SET));

        // Bundles that own no id today change nothing, so a later slice's id appears the moment
        // it is added to its row and not before.
        let no_files = off(&[FILES, MEMORY, CODE, LONG_RESEARCH]).advertised_action_ids(false);
        assert_eq!(no_files, TEAM_AI_ACTION_IDS);

        // After the request has read something the sensitive ids leave (B4-3: the two invites
        // and the roles card — the ids on the allow-list); the other eleven stay.
        let tainted = TeamAiRoles::default().advertised_action_ids(true);
        assert_eq!(tainted.len(), 11);
        for id in [
            ACTION_INVITE_CREATE,
            ACTION_AGENT_INVITE,
            ACTION_TEAM_AI_ROLES_SET,
        ] {
            assert!(!tainted.contains(&id), "{id}");
        }
        assert!(off(&[WORKSPACE_ADMIN, INVITE_ACCESS])
            .advertised_action_ids(true)
            .is_empty());
    }

    /// What a read takes away is exactly the difference between the two enums — never an id the
    /// request was not offered in the first place (a bundle that is off has nothing to lose).
    #[test]
    fn what_a_read_withholds_is_the_difference_of_the_two_enums() {
        let roles = TeamAiRoles::default();
        assert_eq!(
            roles.withheld_by_read(),
            [
                ACTION_INVITE_CREATE,
                ACTION_AGENT_INVITE,
                ACTION_TEAM_AI_ROLES_SET
            ]
        );
        let no_invites = off(&[INVITE_ACCESS]);
        assert_eq!(no_invites.withheld_by_read(), [ACTION_TEAM_AI_ROLES_SET]);
        for roles in [
            roles,
            no_invites,
            off(&[WORKSPACE_ADMIN]),
            off(&[WORKSPACE_ADMIN, INVITE_ACCESS]),
        ] {
            let clean = roles.advertised_action_ids(false);
            let read = roles.advertised_action_ids(true);
            let diff: Vec<&str> = clean
                .iter()
                .copied()
                .filter(|id| !read.contains(id))
                .collect();
            assert_eq!(roles.withheld_by_read(), diff);
        }
    }

    /// B4-3: the sensitive set is the five ids, exactly, and each one that is on the allow-list is
    /// really removed by `tainted`. The two that are not on the allow-list yet are inert today and
    /// must stay off it until their own slice opens them.
    #[test]
    fn the_sensitive_set_is_the_five_of_b4_3() {
        assert_eq!(
            SENSITIVE_ACTION_IDS,
            [
                "invite.create",
                "agent.invite",
                "member.role.set",
                "host.session.open",
                "team_ai.roles.set"
            ]
        );
        for id in SENSITIVE_ACTION_IDS {
            assert!(is_sensitive_action(id), "{id}");
            if TEAM_AI_ACTION_IDS.contains(&id) {
                assert!(
                    !TeamAiRoles::default()
                        .advertised_action_ids(true)
                        .contains(&id),
                    "{id} must leave a request that has read something"
                );
            }
        }
        for id in [ACTION_MEMBER_ROLE_SET, ACTION_HOST_SESSION_OPEN] {
            assert!(
                !TEAM_AI_ACTION_IDS.contains(&id),
                "{id} is not the helper's yet"
            );
        }
        // A card that is not sensitive stays proposable after a read.
        assert!(!is_sensitive_action(ACTION_CHANNEL_CREATE));
        assert!(!is_sensitive_action(ACTION_PLUGIN_INSTALL));
    }

    /// `action_allowed` is the same judgement for one id (what the proposal and the decision
    /// ask), including for an id no bundle owns.
    #[test]
    fn one_id_is_judged_by_its_owner() {
        let roles = off(&[WORKSPACE_ADMIN]);
        assert!(!roles.action_allowed(ACTION_CHANNEL_CREATE));
        assert!(!roles.action_allowed(ACTION_PLUGIN_INSTALL));
        assert!(roles.action_allowed(ACTION_TEAM_AI_ROLES_SET));
        assert!(TeamAiRoles::default().action_allowed(ACTION_CHANNEL_CREATE));
        assert_eq!(
            bundle_of_action(ACTION_CHANNEL_CREATE).map(|b| b.id),
            Some(WORKSPACE_ADMIN)
        );
        assert!(bundle_of_action(ACTION_TEAM_AI_ROLES_SET).is_none());
    }

    /// #4972 (S9): the `code` bundle owns the work-request card, and nothing but `code` gates it.
    #[test]
    fn the_work_request_card_follows_the_code_bundle_alone() {
        assert_eq!(
            TeamAiRoles::default().advertised_command_ids(),
            [COMMAND_WORK_REQUEST_OPEN]
        );
        assert!(off(&[CODE]).advertised_command_ids().is_empty());
        assert!(!off(&[CODE]).command_allowed(COMMAND_WORK_REQUEST_OPEN));
        // Every other bundle off changes nothing for it.
        let others = off(&[WORKSPACE_ADMIN, INVITE_ACCESS, LONG_RESEARCH, FILES, MEMORY]);
        assert_eq!(others.advertised_command_ids(), [COMMAND_WORK_REQUEST_OPEN]);
        assert_eq!(
            bundle_of_command(COMMAND_WORK_REQUEST_OPEN).map(|bundle| bundle.id),
            Some(CODE)
        );
        // Unreadable settings never read as "on".
        assert!(TeamAiRoles::none_on().advertised_command_ids().is_empty());
        // A command the helper does not give is not advertised, bundle on or off; a command no
        // bundle owns is not bundle-gated (the allow-list is the separate check).
        assert!(!TeamAiRoles::default()
            .advertised_command_ids()
            .contains(&"settings.open"));
        assert!(bundle_of_command("settings.open").is_none());
        assert!(TeamAiRoles::none_on().command_allowed("settings.open"));
    }

    /// A bundle that names a command nobody offers filters nothing: the table must not carry one,
    /// and a misspelling must be found rather than read as "no such command is offered".
    #[test]
    fn every_bundle_command_id_is_one_the_helper_allow_list_carries() {
        assert!(unknown_command_ids(&BUNDLES).is_empty());
        let misspelt = [RoleBundle {
            id: CODE,
            label: "코드",
            action_ids: &[],
            tool_names: &[],
            command_ids: &["work.request.opn"],
            notice: None,
        }];
        assert_eq!(unknown_command_ids(&misspelt), ["work.request.opn"]);
        for id in TEAM_AI_SUGGESTABLE_COMMAND_IDS {
            assert!(
                crate::card_suggest::suggestable_command(id).is_some(),
                "{id} is on the helper list but not on the server allow-list"
            );
        }
    }

    /// The seam later slices fill: a tool a bundle owns is dropped while the bundle is off and a
    /// tool nobody owns is never touched. Measured over a table with entries, because today's has
    /// none.
    #[test]
    fn a_tool_a_bundle_owns_is_dropped_with_it() {
        let mut table = BUNDLES;
        table[3].tool_names = &["read_attachment"]; // files
        table[1].tool_names = &["task_continue", "read_attachment"]; // a tool owned twice needs both
        let all_on = TeamAiRoles::default();
        assert!(tool_allowed_in(&table, &all_on, "read_attachment"));
        assert!(!tool_allowed_in(&table, &off(&[FILES]), "read_attachment"));
        assert!(!tool_allowed_in(
            &table,
            &off(&[INVITE_ACCESS]),
            "read_attachment"
        ));
        assert!(!tool_allowed_in(
            &table,
            &off(&[INVITE_ACCESS]),
            "task_continue"
        ));
        assert!(tool_allowed_in(&table, &off(&[FILES]), "task_continue"));
        assert!(tool_allowed_in(&table, &off(&[FILES]), "search_messages"));
        // And through the public seam: today nothing is owned, so nothing is dropped.
        assert!(off(&[FILES, MEMORY]).tool_allowed("search_messages"));
    }

    /// What a reader that could not read the settings answers with when the answer decides a
    /// refusal: every switch off — `chat_read` is not a switch and stays on, and an action no
    /// bundle owns (the roles card) is not bundle-gated either way.
    #[test]
    fn none_on_turns_every_switch_off() {
        let none = TeamAiRoles::none_on();
        assert_eq!(none.off_bundles(), SWITCHABLE_BUNDLES);
        assert!(none.is_on(CHAT_READ));
        assert!(!none.action_allowed(ACTION_CHANNEL_CREATE));
        assert!(none.action_allowed(ACTION_TEAM_AI_ROLES_SET));
        assert_ne!(none, TeamAiRoles::default());
    }

    /// The checker that guards the names: a table whose `tool_names` carries a misspelling is
    /// found, a table of names that all exist is not.
    #[test]
    fn a_misspelt_bundle_tool_name_is_found() {
        let mut table = BUNDLES;
        table[3].tool_names = &["read_attachment", "read_atachment"]; // files
        table[4].tool_names = &["search_memory"]; // memory
        let known = [
            "read_attachment",
            "search_memory",
            "search_messages",
            TASK_CONTINUE,
        ];
        assert_eq!(unknown_tool_names(&table, &known), ["read_atachment"]);
        table[3].tool_names = &["read_attachment"];
        assert!(unknown_tool_names(&table, &known).is_empty());
        // And the shipped table names only tools that exist (`task_continue`, `read_attachment`).
        assert!(unknown_tool_names(&BUNDLES, &known).is_empty());
        assert_eq!(bundle(FILES).unwrap().tool_names, [TOOL_READ_ATTACHMENT]);
    }

    /// B5-3 / B13-I5 (#4967): the task-mode tool is owned by `long_research` and by nothing else —
    /// the request builder's `tool_allowed` filter drops it with that one bundle, and no other
    /// switch moves it.
    #[test]
    fn task_continue_leaves_with_long_research_and_with_nothing_else() {
        let all_on = TeamAiRoles::default();
        assert!(all_on.tool_allowed(TASK_CONTINUE));
        let research_off = all_on.with(LONG_RESEARCH, false);
        assert!(!research_off.tool_allowed(TASK_CONTINUE));
        assert!(!TeamAiRoles::none_on().tool_allowed(TASK_CONTINUE));
        for other in [WORKSPACE_ADMIN, INVITE_ACCESS, FILES, MEMORY, CODE] {
            assert!(
                all_on.with(other, false).tool_allowed(TASK_CONTINUE),
                "{other} must not move the task tool"
            );
        }
        // The reads and the proposal tool are not bundle-gated: they stay with the bundle off.
        assert!(research_off.tool_allowed("search_messages"));
        assert!(research_off.tool_allowed(crate::tools::WORKSPACE_ACTION_PROPOSE));
        assert_eq!(bundle(LONG_RESEARCH).unwrap().tool_names, [TASK_CONTINUE]);
    }

    #[test]
    fn only_files_and_memory_carry_a_notice_and_only_when_turned_on() {
        for bundle in BUNDLES {
            let expected = bundle.id == FILES || bundle.id == MEMORY;
            assert_eq!(bundle.notice.is_some(), expected, "{}", bundle.id);
            assert_eq!(notice_for(bundle.id).is_some(), expected, "{}", bundle.id);
            let on = roles_set_rows(&bundle, false, true);
            let turned_off = roles_set_rows(&bundle, true, false);
            assert_eq!(on.len(), if expected { 2 } else { 1 }, "{}", bundle.id);
            assert_eq!(turned_off.len(), 1, "{}", bundle.id);
            assert!(on[0]["value"].as_str().unwrap().contains(bundle.label));
        }
        assert!(notice_for(FILES).unwrap().contains("팀 AI 공급자"));
        assert!(notice_for(MEMORY).unwrap().contains("팀 AI 공급자"));
    }

    /// The role table in the prompt names every bundle and says nothing about what one allows.
    #[test]
    fn the_prompt_table_is_names_only() {
        let table = prompt_role_table();
        for bundle in BUNDLES {
            assert!(table.contains(&format!("{}={}", bundle.id, bundle.label)));
        }
        assert!(!table.contains(CHAT_READ));
        for id in TEAM_AI_ACTION_IDS {
            assert!(!table.contains(id), "{id}");
        }
    }
}
