//! The domain half of the team AI's role switches (ADR-0201 증보 v3 B3, #4964 S1).
//!
//! `momo_agent::team_ai_roles` is the pure half: the bundle table, the reader, the filters.
//! This is the half that touches the database, and it is **the one place** the three writers of
//! `workspace.settings.team_ai_roles` share:
//!
//! * `PATCH …/settings` (an admin, from the settings screen) — merges through
//!   `momo_settings::merge_workspace_settings`, then asks [`memory_prerequisite_in_tx`] and
//!   writes [`roles_changed_audit`];
//! * the card `team_ai.roles.set` (an admin approves in a chat) — [`set_role_in_tx`], which is
//!   the same merge and the same write, plus the stale-card and prerequisite checks;
//! * the onboarding role step and the settings screen (#4945) — [`record_notice_in_tx`] for the
//!   consent record (a card's own record is [`card_notice_audit`]'s, and needs its approval).
//!
//! ## The consent record (「어떤 내용이 팀 AI 공급자에게 가는지」)
//!
//! When an admin turns `files` or `memory` **on**, the card or the onboarding step has shown
//! them the sentence that says what goes to the team's AI provider. The record
//! ([`card_notice_audit`] for a card, [`record_notice_in_tx`] for a screen) says who (actor),
//! when (the row's own time) and which wording ([`momo_agent::team_ai_roles::NOTICE_VERSION`]).
//! It is an `audit_log` row — no new table — and it never gates anything: the bundles are on
//! from the start (owner answer 2026-11-01), so a missing record blocks nothing.

use momo_agent::team_ai_roles::{self as roles, TeamAiRoles};
use momo_db::audit::{write_audit, AuditEntry};
use momo_db::{DbError, PgConnection};
use momo_settings::{
    merge_workspace_settings, read_workspace_settings_for_update, write_workspace_settings,
    TEAM_AI_ROLES_SETTING,
};
use serde_json::{json, Value};
use uuid::Uuid;

/// The names of the switches whose effective state differs, in table order.
pub fn changed_keys(before: &TeamAiRoles, after: &TeamAiRoles) -> Vec<&'static str> {
    roles::SWITCHABLE_BUNDLES
        .iter()
        .copied()
        .filter(|id| before.is_on(id) != after.is_on(id))
        .collect()
}

/// The agent proposal a change came through, when it came through one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CardProvenance {
    pub agent_member_id: Uuid,
    pub approval_id: Uuid,
    pub run_id: Uuid,
}

/// The audit row of a change to the switches: **key names only** (the card the approver read
/// shows the direction, and a settings value is not copied into a log).
pub fn roles_changed_audit(
    workspace_id: Uuid,
    actor: Uuid,
    via_token_id: Option<Uuid>,
    keys: &[&'static str],
    card: Option<CardProvenance>,
) -> AuditEntry {
    let entry = AuditEntry::new(workspace_id, roles::AUDIT_ROLES_CHANGED)
        .by(actor)
        .target("workspace", workspace_id)
        .via_token(via_token_id);
    match card {
        Some(card) => entry
            .about(card.agent_member_id)
            .run(card.run_id)
            .with_schema(
                roles::AUDIT_ROLES_CHANGED_SCHEMA,
                json!({
                    "keys": keys,
                    "source": "card",
                    "via_agent": card.agent_member_id.to_string(),
                    "approval_id": card.approval_id.to_string(),
                }),
            ),
        None => entry.with_schema(
            roles::AUDIT_ROLES_CHANGED_SCHEMA,
            json!({ "keys": keys, "source": "settings" }),
        ),
    }
}

/// The screens that show the 「공급자로 가는 내용」 line outside a card. **This is the whole set a
/// screen may name** — a card's consent is [`card_notice_audit`]'s, which needs the approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenNotice {
    /// The onboarding role step (#4945).
    Onboarding,
    /// The settings screen's role row (#4945).
    Settings,
}

impl ScreenNotice {
    pub fn as_str(self) -> &'static str {
        match self {
            ScreenNotice::Onboarding => "onboarding",
            ScreenNotice::Settings => "settings",
        }
    }
}

/// Where the admin was shown the notice, with what proves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoticeSource {
    /// The `team_ai.roles.set` card that turns the bundle on — and the approval that is the
    /// consent. There is no card source without one.
    Card {
        approval_id: Uuid,
    },
    Screen(ScreenNotice),
}

impl NoticeSource {
    fn via(self) -> &'static str {
        match self {
            NoticeSource::Card { .. } => "card",
            NoticeSource::Screen(screen) => screen.as_str(),
        }
    }

    fn approval_id(self) -> Option<String> {
        match self {
            NoticeSource::Card { approval_id } => Some(approval_id.to_string()),
            NoticeSource::Screen(_) => None,
        }
    }
}

/// The one shape of the consent record, for every writer: the bundles in `bundle_ids` that carry
/// a notice, or `None` when none does. Private, so a record that says it came from a card cannot
/// be built without the approval ([`card_notice_audit`]).
fn notice_entry(
    workspace_id: Uuid,
    actor: Uuid,
    via_token_id: Option<Uuid>,
    bundle_ids: &[&str],
    source: NoticeSource,
) -> Option<AuditEntry> {
    let bundles: Vec<&'static str> = roles::SWITCHABLE_BUNDLES
        .iter()
        .copied()
        .filter(|id| bundle_ids.contains(id) && roles::notice_for(id).is_some())
        .collect();
    if bundles.is_empty() {
        return None;
    }
    Some(
        AuditEntry::new(workspace_id, roles::AUDIT_ROLES_NOTICE)
            .by(actor)
            .target("workspace", workspace_id)
            .via_token(via_token_id)
            .with_schema(
                roles::AUDIT_ROLES_NOTICE_SCHEMA,
                json!({
                    "bundles": bundles,
                    "notice_version": roles::NOTICE_VERSION,
                    "via": source.via(),
                    "approval_id": source.approval_id(),
                }),
            ),
    )
}

/// The consent record of the approval of a `team_ai.roles.set` card that turns a noticed bundle
/// on, or `None` when none of `bundle_ids` carries a notice. The executor hands the entry to the
/// decision's shared audit tail. **The approval's id is required by the type**: this is the only
/// way to build a record that says `via: card`.
pub fn card_notice_audit(
    workspace_id: Uuid,
    actor: Uuid,
    via_token_id: Option<Uuid>,
    bundle_ids: &[&str],
    approval_id: Uuid,
) -> Option<AuditEntry> {
    notice_entry(
        workspace_id,
        actor,
        via_token_id,
        bundle_ids,
        NoticeSource::Card { approval_id },
    )
}

/// Write the consent record of a **screen** (onboarding or settings, #4945) in the caller's
/// transaction. Returns whether a row was written — `false` when none of `bundle_ids` carries a
/// notice. A card's consent is not writable from here: it is the approval's own record.
///
/// The caller owns the judgement that `actor` is the signed-in admin who was shown the line — this
/// function records what it is told, like every audit writer; the screens' route gates on the
/// workspace admin before it calls.
pub async fn record_notice_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor: Uuid,
    via_token_id: Option<Uuid>,
    bundle_ids: &[&str],
    screen: ScreenNotice,
) -> Result<bool, DbError> {
    let Some(entry) = notice_entry(
        workspace_id,
        actor,
        via_token_id,
        bundle_ids,
        NoticeSource::Screen(screen),
    ) else {
        return Ok(false);
    };
    write_audit(conn, &entry).await?;
    Ok(true)
}

/// Is team memory switched on for this workspace? Read the way `PATCH …/memory/settings` reads
/// it — `app.member_id` bound to `member_id`, so the `mem_settings` policy judges that person —
/// and with the binding put back afterwards. **No workspace row = on** (ADR-0196 D9).
pub async fn team_memory_is_on_in_tx(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<bool, DbError> {
    // Only the named binders touch `app.member_id` (ADR-0208 D14: a source scan pins who may):
    // read what the transaction holds, bind the approver for the `mem_settings` policy, then
    // put back exactly what was there.
    let previous = momo_messaging::current_owner_guc(conn).await?;
    momo_messaging::bind_mem_reader_guc(conn, member_id).await?;
    let on = momo_messaging::list_settings_in_tx(conn)
        .await?
        .into_iter()
        .find(|row| row.scope == "workspace")
        .map(|row| row.enabled)
        .unwrap_or(true);
    match Uuid::parse_str(&previous) {
        Ok(held) => momo_messaging::bind_owner_guc(conn, held).await?,
        Err(_) => momo_messaging::clear_owner_guc(conn).await?,
    }
    Ok(on)
}

/// The prerequisite of turning `memory` on (the issue's 「팀 기억이 꺼져 있으면 기억 켜기 409」):
/// a write that takes the bundle from off to on needs team memory switched on. Judged on the
/// **effective** change, so a settings screen that sends all six fields on every save is not
/// stopped by a `memory: true` it did not change. `true` = go ahead.
pub async fn memory_prerequisite_in_tx(
    conn: &mut PgConnection,
    actor: Uuid,
    before: &TeamAiRoles,
    after: &TeamAiRoles,
) -> Result<bool, DbError> {
    if before.is_on(roles::MEMORY) || !after.is_on(roles::MEMORY) {
        return Ok(true);
    }
    team_memory_is_on_in_tx(conn, actor).await
}

/// What [`set_role_in_tx`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleWrite {
    /// The switch moved; `before` is what it was.
    Changed { before: bool },
    /// The switch is not what the card said it was (or already is what was asked): the card
    /// is stale and nothing was written.
    Stale,
    /// Turning `memory` on while team memory is switched off: nothing was written.
    TeamMemoryOff,
}

/// Switch ONE bundle, as the approver, under the row lock — the write `PATCH …/settings` makes
/// for `{team_ai_roles: {bundle: enabled}}`: the same `merge_workspace_settings`, the same
/// `write_workspace_settings`.
///
/// `expect_before` is the switch the approver was shown. The bag is re-read `FOR UPDATE` (the
/// resolver read it unlocked); a switch that has since moved is [`RoleWrite::Stale`], not a
/// write the approver never saw. After the merge a belt-and-braces check proves that **only that
/// one field of that one key moved**, and a result that disagrees rolls the decision back.
pub async fn set_role_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor: Uuid,
    bundle: &str,
    enabled: bool,
    expect_before: bool,
) -> Result<RoleWrite, DbError> {
    if !roles::SWITCHABLE_BUNDLES.contains(&bundle) {
        return Err(DbError::from(sqlx::Error::Protocol(
            "team_ai.roles.set reached the executor with a bundle that is not switchable".into(),
        )));
    }
    let Some(existing) = read_workspace_settings_for_update(conn, workspace_id).await? else {
        return Err(DbError::from(sqlx::Error::RowNotFound));
    };
    let existing = if existing.is_object() {
        existing
    } else {
        json!({})
    };
    let before_roles = TeamAiRoles::from_settings(&existing);
    let before = before_roles.is_on(bundle);
    if before != expect_before || before == enabled {
        return Ok(RoleWrite::Stale);
    }
    let after_roles = before_roles.with(bundle, enabled);
    if !memory_prerequisite_in_tx(conn, actor, &before_roles, &after_roles).await? {
        return Ok(RoleWrite::TeamMemoryOff);
    }
    let patch = json!({ TEAM_AI_ROLES_SETTING: { bundle: enabled } });
    let Ok(merged) = merge_workspace_settings(&existing, &patch) else {
        return Ok(RoleWrite::Stale);
    };
    if !only_that_switch_moved(&existing, &merged, bundle)
        || TeamAiRoles::from_settings(&merged) != after_roles
    {
        return Err(DbError::from(sqlx::Error::Protocol(
            "team_ai.roles.set changed more than the one switch it names".into(),
        )));
    }
    write_workspace_settings(conn, workspace_id, &merged)
        .await?
        .ok_or_else(|| DbError::from(sqlx::Error::RowNotFound))?;
    Ok(RoleWrite::Changed { before })
}

/// Did the merge touch nothing but `team_ai_roles.<bundle>`? Every other key of the bag is equal,
/// and every other field of the roles object is equal.
fn only_that_switch_moved(existing: &Value, merged: &Value, bundle: &str) -> bool {
    let strip = |bag: &Value| -> (Value, Value) {
        let mut bag = bag.clone();
        let roles = bag
            .as_object_mut()
            .and_then(|map| map.remove(TEAM_AI_ROLES_SETTING));
        let mut fields = match roles {
            Some(Value::Object(fields)) => fields,
            _ => serde_json::Map::new(),
        };
        fields.remove(bundle);
        (bag, Value::Object(fields))
    };
    strip(existing) == strip(merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_keys_are_the_effective_differences_only() {
        let all_on = TeamAiRoles::default();
        let files_off = all_on.with(roles::FILES, false);
        assert_eq!(changed_keys(&all_on, &files_off), [roles::FILES]);
        assert!(changed_keys(&files_off, &files_off).is_empty());
        // Writing `true` over an absent field changes nothing a reader can see.
        assert!(changed_keys(
            &TeamAiRoles::from_settings(&json!({})),
            &TeamAiRoles::from_settings(&json!({"team_ai_roles": {"files": true}}))
        )
        .is_empty());
        let two = files_off.with(roles::CODE, false);
        assert_eq!(changed_keys(&all_on, &two), [roles::FILES, roles::CODE]);
    }

    /// The audit row names keys and never a value, from any writer.
    #[test]
    fn the_changed_audit_carries_key_names_and_no_values() {
        let workspace = Uuid::from_u128(1);
        let admin = Uuid::from_u128(2);
        let settings = roles_changed_audit(workspace, admin, None, &[roles::FILES], None);
        assert_eq!(settings.action, "team_ai.roles.changed");
        assert_eq!(settings.detail["keys"], json!(["files"]));
        assert_eq!(settings.detail["source"], "settings");
        let card = roles_changed_audit(
            workspace,
            admin,
            None,
            &[roles::MEMORY],
            Some(CardProvenance {
                agent_member_id: Uuid::from_u128(3),
                approval_id: Uuid::from_u128(4),
                run_id: Uuid::from_u128(5),
            }),
        );
        assert_eq!(card.detail["source"], "card");
        assert_eq!(card.detail["approval_id"], Uuid::from_u128(4).to_string());
        for entry in [&settings, &card] {
            let text = entry.detail.to_string();
            assert!(!text.contains("true") && !text.contains("false"), "{text}");
        }
    }

    /// Only a bundle with a notice is recorded, and the record names the wording it quotes. A card's
    /// record carries its approval; a screen's carries none.
    #[test]
    fn the_notice_record_covers_only_bundles_with_a_notice() {
        let workspace = Uuid::from_u128(1);
        let admin = Uuid::from_u128(2);
        let approval = Uuid::from_u128(9);
        assert!(card_notice_audit(
            workspace,
            admin,
            None,
            &[roles::WORKSPACE_ADMIN, roles::CODE, roles::INVITE_ACCESS],
            approval
        )
        .is_none());
        let screen = notice_entry(
            workspace,
            admin,
            None,
            &[roles::MEMORY, roles::FILES, roles::CODE],
            NoticeSource::Screen(ScreenNotice::Onboarding),
        )
        .expect("files and memory carry a notice");
        assert_eq!(screen.action, "team_ai.roles.notice_shown");
        assert_eq!(screen.actor_member_id, Some(admin));
        assert_eq!(screen.detail["bundles"], json!(["files", "memory"]));
        assert_eq!(screen.detail["notice_version"], roles::NOTICE_VERSION);
        assert_eq!(screen.detail["via"], "onboarding");
        assert_eq!(screen.detail["approval_id"], Value::Null);
        let card = card_notice_audit(workspace, admin, None, &[roles::FILES], approval)
            .expect("a card that turns files on");
        assert_eq!(card.detail["via"], "card");
        assert_eq!(card.detail["approval_id"], approval.to_string());
    }

    #[test]
    fn the_merge_belt_notices_a_second_switch_or_a_second_key_moving() {
        let existing = json!({"role_labels": {"owner": "대표"}, "team_ai_roles": {"files": false}});
        let right =
            merge_workspace_settings(&existing, &json!({"team_ai_roles": {"memory": false}}))
                .unwrap();
        assert!(only_that_switch_moved(&existing, &right, "memory"));
        // Another switch moved too.
        let two = merge_workspace_settings(
            &existing,
            &json!({"team_ai_roles": {"memory": false, "code": false}}),
        )
        .unwrap();
        assert!(!only_that_switch_moved(&existing, &two, "memory"));
        // A switch other than the named one moved.
        assert!(!only_that_switch_moved(&existing, &right, "code"));
        // Another key of the bag moved.
        let mut foreign = right.clone();
        foreign["role_labels"] = json!({"owner": "마스터"});
        assert!(!only_that_switch_moved(&existing, &foreign, "memory"));
    }

    /// Every tool a bundle owns must be a tool the helper can be offered: the request's tool list
    /// is filtered by these names, and a name that matches no tool filters nothing. (Today's table
    /// owns none, so this is the guard the first slice that adds one runs into.)
    #[test]
    fn every_bundle_tool_name_is_a_tool_the_helper_can_be_offered() {
        let mut known: Vec<&str> = crate::team_ai_tools::read_tool_definitions()
            .iter()
            .map(|tool| tool.name)
            .collect();
        known.push(momo_agent::tools::WORKSPACE_ACTION_PROPOSE);
        known.extend(
            momo_agent::tools::catalog_definitions()
                .iter()
                .map(|tool| tool.name),
        );
        assert_eq!(
            roles::unknown_tool_names(&roles::BUNDLES, &known),
            Vec::<&str>::new(),
            "a bundle's tool_names names a tool the helper is never offered"
        );
    }

    /// `momo-settings` cannot see `momo-agent`, so the six bundle names and the key are written in
    /// both; this crate sees both and holds them equal.
    #[test]
    fn the_settings_crate_and_the_bundle_table_agree_on_the_switches() {
        assert_eq!(
            momo_settings::TEAM_AI_ROLES_KEYS,
            roles::SWITCHABLE_BUNDLES,
            "momo_settings::TEAM_AI_ROLES_KEYS drifted from momo_agent::team_ai_roles"
        );
        assert_eq!(momo_settings::TEAM_AI_ROLES_SETTING, roles::SETTINGS_KEY);
        assert!(momo_settings::ALLOWED_SETTINGS_KEYS.contains(&roles::SETTINGS_KEY));
    }
}
