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
//! [`BUNDLES`] is the one place that says what each bundle owns. Today only
//! `workspace_admin` owns anything (the eleven cards of ADR-0201 증보 v2 F2); the others are
//! empty slots, so a later slice (S2 invites, S4 long work, S7 files, S8 memory, S9 code)
//! adds an id to its row and nothing else: the filters below read the table.
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
    ACTION_CHANNEL_MEMBER_ADD, ACTION_INVITE_CREATE, ACTION_MEMBER_AVATAR_SET,
    ACTION_MEMBER_DISPLAY_NAME_SET, ACTION_PLUGIN_INSTALL, ACTION_TEAM_AI_ROLES_SET,
    ACTION_WORKSPACE_MEMORY_UPDATE, ACTION_WORKSPACE_SETTINGS_UPDATE,
    ACTION_WORKSPACE_UNFURL_UPDATE, ACTION_WORKSPACE_WORK_TIER_UPDATE, TEAM_AI_ACTION_IDS,
};

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
        notice: None,
    },
    // S2 puts these two on `TEAM_AI_ACTION_IDS`; mapping them now means that edit is the only one.
    RoleBundle {
        id: INVITE_ACCESS,
        label: "초대·권한",
        action_ids: &[ACTION_INVITE_CREATE, ACTION_AGENT_INVITE],
        tool_names: &[],
        notice: None,
    },
    RoleBundle {
        id: LONG_RESEARCH,
        label: "긴 조사",
        action_ids: &[],
        tool_names: &[],
        notice: None,
    },
    RoleBundle {
        id: FILES,
        label: "파일",
        action_ids: &[],
        tool_names: &[],
        notice: Some(NOTICE_FILES),
    },
    RoleBundle {
        id: MEMORY,
        label: "기억",
        action_ids: &[],
        tool_names: &[],
        notice: Some(NOTICE_MEMORY),
    },
    RoleBundle {
        id: CODE,
        label: "코드",
        action_ids: &[],
        tool_names: &[],
        notice: None,
    },
];

/// B4-3 오염 규칙 (the frame; S2 adds the two invite ids): once a request's model context holds
/// anything it **read** — a workspace read tool's result or a web search's — these ids leave the
/// `actionId` enum of every later call, and a proposal of one is refused. A person who asks
/// directly (no read in the request) still gets the card.
pub const SENSITIVE_ACTION_IDS: [&str; 1] = [ACTION_TEAM_AI_ROLES_SET];

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

    /// The filter every consumer reads: eleven + the roles card by default; a bundle that is off
    /// takes its ids out and nothing else; the roles card stays while `workspace_admin` is off.
    #[test]
    fn advertised_ids_follow_the_switches() {
        let all = TeamAiRoles::default().advertised_action_ids(false);
        assert_eq!(all, TEAM_AI_ACTION_IDS);
        assert_eq!(all.len(), 12);

        let no_admin = off(&[WORKSPACE_ADMIN]).advertised_action_ids(false);
        assert_eq!(no_admin, [ACTION_TEAM_AI_ROLES_SET]);

        // Bundles that own no id today change nothing, so a later slice's id appears the moment
        // it is added to its row and not before.
        let no_files =
            off(&[FILES, MEMORY, CODE, LONG_RESEARCH, INVITE_ACCESS]).advertised_action_ids(false);
        assert_eq!(no_files, TEAM_AI_ACTION_IDS);

        // After the request has read something the sensitive ids leave; the rest stay.
        let tainted = TeamAiRoles::default().advertised_action_ids(true);
        assert_eq!(tainted.len(), 11);
        assert!(!tainted.contains(&ACTION_TEAM_AI_ROLES_SET));
        assert!(off(&[WORKSPACE_ADMIN])
            .advertised_action_ids(true)
            .is_empty());
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
