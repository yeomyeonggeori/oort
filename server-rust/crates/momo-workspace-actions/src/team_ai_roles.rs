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
//! * the onboarding role step and the settings screen (#4945, #5040) — a screen carries
//!   `team_ai_roles_notice` on the settings PATCH it already sends; [`take_screen_notice`] lifts it
//!   out of the body and [`record_notice_in_tx`] writes the consent record (a card's own record is
//!   [`card_notice_audit`]'s, and needs its approval).
//!
//! ## The consent record (「어떤 내용이 팀 AI 공급자에게 가는지」)
//!
//! When an admin turns `files` or `memory` **on**, the card or the onboarding step has shown
//! them the sentence that says what goes to the team's AI provider. The record
//! ([`card_notice_audit`] for a card, [`record_notice_in_tx`] for a screen) says who (actor),
//! when (the row's own time) and which wording: a card quotes the server's own
//! [`momo_agent::team_ai_roles::NOTICE_VERSION`] (the server wrote the sentence), a screen quotes
//! the version **it** says it showed ([`ScreenNoticeClaim`]) — its words live in the client's
//! catalog, and a record that stamped the server's newest version would let an older client's
//! older words read as the newer ones.
//! It is an `audit_log` row — no new table — and it never gates anything: the bundles are on
//! from the start (owner answer 2026-11-01), so a missing record blocks nothing. What the server
//! does refuse is a record it cannot make sense of ([`NoticeClaimInvalid`]): a claim about a
//! wording or a bundle it does not know is a client that has drifted, and says so with a 400
//! instead of leaving a record that says something else.

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
    /// Every screen, in the order the wire names them. `as_str` and [`Self::from_wire`] both read
    /// this, so a screen added here is named and parsed in one place.
    pub const ALL: [ScreenNotice; 2] = [ScreenNotice::Onboarding, ScreenNotice::Settings];

    pub fn as_str(self) -> &'static str {
        match self {
            ScreenNotice::Onboarding => "onboarding",
            ScreenNotice::Settings => "settings",
        }
    }

    /// The screen a request names. **`card` is not one**: a card's consent is the approval's own
    /// record ([`card_notice_audit`]) and has no door a screen can knock on.
    pub fn from_wire(raw: &str) -> Option<ScreenNotice> {
        Self::ALL.into_iter().find(|screen| screen.as_str() == raw)
    }
}

/// The key a screen carries the consent record under, on the body of `PATCH …/settings`
/// (#5040). **Request-only**: it is not a setting, so it is not in
/// `momo_settings::ALLOWED_SETTINGS_KEYS`, never stored in the bag and never echoed. The route
/// takes it out with [`take_screen_notice`] before the bag logic sees the body.
pub const SCREEN_NOTICE_FIELD: &str = "team_ai_roles_notice";

/// Why a `team_ai_roles_notice` was refused. Each is a 400 at the route and nothing is written;
/// the message is for a developer (a screen words its own errors).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoticeClaimInvalid {
    /// Not an object.
    Shape,
    /// A field other than `bundles`, `noticeVersion` and `via` — an approval id included: a
    /// screen's record carries none (that is what makes it a screen's).
    UnknownField(String),
    /// `bundles` is missing, not an array, empty, too long, holds a non-string, or names a bundle twice.
    Bundles,
    /// A bundle that carries no notice (`code`, `invite_access`, …), `chat_read`, or a name that
    /// is no bundle at all.
    UnknownBundle(String),
    /// `noticeVersion` is missing, not a string, or a wording the server does not list.
    Version,
    /// `via` is missing, or not `onboarding` / `settings`.
    Via,
}

impl std::fmt::Display for NoticeClaimInvalid {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Shape => write!(
                out,
                "{SCREEN_NOTICE_FIELD} must be an object of bundles, noticeVersion and via"
            ),
            Self::UnknownField(name) => write!(out, "unknown {SCREEN_NOTICE_FIELD} field: {name}"),
            Self::Bundles => write!(
                out,
                "{SCREEN_NOTICE_FIELD}.bundles must be a non-empty array of distinct bundle names that carry a notice"
            ),
            Self::UnknownBundle(name) => write!(
                out,
                "{SCREEN_NOTICE_FIELD}.bundles names a bundle that carries no notice: {name}"
            ),
            Self::Version => write!(
                out,
                "{SCREEN_NOTICE_FIELD}.noticeVersion must be a notice wording version the server lists"
            ),
            Self::Via => write!(
                out,
                "{SCREEN_NOTICE_FIELD}.via must be onboarding or settings"
            ),
        }
    }
}

impl std::error::Error for NoticeClaimInvalid {}

/// What a screen says it showed, **already judged**: the only way to get one is [`parse_screen_notice`]
/// (or [`take_screen_notice`]), so every field is a member of a closed set and the audit row holds
/// the server's own spelling of it — nothing the client typed reaches the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenNoticeClaim {
    screen: ScreenNotice,
    notice_version: &'static str,
    bundles: Vec<&'static str>,
}

impl ScreenNoticeClaim {
    pub fn screen(&self) -> ScreenNotice {
        self.screen
    }

    /// The wording the screen showed — an entry of [`roles::NOTICE_VERSIONS`].
    pub fn notice_version(&self) -> &'static str {
        self.notice_version
    }

    /// The bundles whose line it showed, in the bundle table's order.
    pub fn bundles(&self) -> &[&'static str] {
        &self.bundles
    }
}

/// [`parse_screen_notice`] against an explicit list of the wordings the server knows, so a test can
/// hold a second version without a second wording shipping.
pub fn parse_screen_notice_against(
    value: &Value,
    known_versions: &[&'static str],
) -> Result<ScreenNoticeClaim, NoticeClaimInvalid> {
    let Some(fields) = value.as_object() else {
        return Err(NoticeClaimInvalid::Shape);
    };
    if let Some(unknown) = fields
        .keys()
        .find(|name| !matches!(name.as_str(), "bundles" | "noticeVersion" | "via"))
    {
        return Err(NoticeClaimInvalid::UnknownField(unknown.clone()));
    }
    let screen = fields
        .get("via")
        .and_then(Value::as_str)
        .and_then(ScreenNotice::from_wire)
        .ok_or(NoticeClaimInvalid::Via)?;
    let notice_version = fields
        .get("noticeVersion")
        .and_then(Value::as_str)
        .and_then(|sent| known_versions.iter().copied().find(|known| *known == sent))
        .ok_or(NoticeClaimInvalid::Version)?;
    // The bundles that carry a notice: the only ones a screen can have shown a line for.
    let noticed: Vec<&'static str> = roles::SWITCHABLE_BUNDLES
        .iter()
        .copied()
        .filter(|id| roles::notice_for(id).is_some())
        .collect();
    let items = fields
        .get("bundles")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty() && items.len() <= roles::SWITCHABLE_BUNDLES.len())
        .ok_or(NoticeClaimInvalid::Bundles)?;
    let mut named: Vec<&'static str> = Vec::with_capacity(items.len());
    for item in items {
        let Some(name) = item.as_str() else {
            return Err(NoticeClaimInvalid::Bundles);
        };
        let Some(id) = noticed.iter().copied().find(|id| *id == name) else {
            return Err(NoticeClaimInvalid::UnknownBundle(name.to_string()));
        };
        if named.contains(&id) {
            return Err(NoticeClaimInvalid::Bundles);
        }
        named.push(id);
    }
    // The bundle table's order, whatever order the screen listed them in.
    let bundles = noticed
        .into_iter()
        .filter(|id| named.contains(id))
        .collect();
    Ok(ScreenNoticeClaim {
        screen,
        notice_version,
        bundles,
    })
}

/// Judge a `team_ai_roles_notice` against the wordings the server lists ([`roles::NOTICE_VERSIONS`]).
pub fn parse_screen_notice(value: &Value) -> Result<ScreenNoticeClaim, NoticeClaimInvalid> {
    parse_screen_notice_against(value, &roles::NOTICE_VERSIONS)
}

/// Take `team_ai_roles_notice` **out of** a settings PATCH body, judged. `None` when the body has
/// none (an older client: nothing is recorded and nothing is blocked) or has `null`, and for a
/// body that is not an object (the bag's own merge refuses that one). After this call the body is
/// what the bag logic has always seen: the one key that is not a setting is gone, so it is never
/// stored, never reaches the allowlist's 400 and never counts as a "key patched" in the settings
/// audit row.
pub fn take_screen_notice(
    body: &mut Value,
) -> Result<Option<ScreenNoticeClaim>, NoticeClaimInvalid> {
    let Some(fields) = body.as_object_mut() else {
        return Ok(None);
    };
    match fields.remove(SCREEN_NOTICE_FIELD) {
        None | Some(Value::Null) => Ok(None),
        Some(claim) => parse_screen_notice(&claim).map(Some),
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
/// a notice, or `None` when none does. `notice_version` is the wording the reader was shown —
/// the caller's to name, never a default here: a card passes the server's own, a screen passes the
/// version it said it showed. Private, so a record that says it came from a card cannot be built
/// without the approval ([`card_notice_audit`]).
fn notice_entry(
    workspace_id: Uuid,
    actor: Uuid,
    via_token_id: Option<Uuid>,
    bundle_ids: &[&str],
    source: NoticeSource,
    notice_version: &str,
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
                    "notice_version": notice_version,
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
        roles::NOTICE_VERSION,
    )
}

/// Write the consent record of a **screen** (onboarding or settings, #4945/#5040) in the caller's
/// transaction: who (`actor`), when (the row's own time), which bundles and which wording **the
/// screen said it showed** (the `claim`, judged by [`parse_screen_notice`]). Returns whether a row
/// was written — always `true` for a judged claim, whose bundles all carry a notice. A card's
/// consent is not writable from here: it is the approval's own record.
///
/// The caller owns the judgement that `actor` is the signed-in admin who was shown the line — this
/// function records what it is told, like every audit writer; the settings route gates on the
/// workspace owner/admin (or the instance operator it already admits) before it calls.
pub async fn record_notice_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor: Uuid,
    via_token_id: Option<Uuid>,
    claim: &ScreenNoticeClaim,
) -> Result<bool, DbError> {
    let Some(entry) = notice_entry(
        workspace_id,
        actor,
        via_token_id,
        claim.bundles(),
        NoticeSource::Screen(claim.screen()),
        claim.notice_version(),
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
            roles::NOTICE_VERSION,
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

    fn claim_body(bundles: Value, version: Value, via: Value) -> Value {
        json!({"bundles": bundles, "noticeVersion": version, "via": via})
    }

    /// #5040: what a screen sends becomes a claim whose every field is the server's own spelling
    /// of a member of a closed set — and the version is the one the screen **named**, not the
    /// server's newest. Held against a two-wording list so the two can differ.
    #[test]
    fn a_screens_claim_carries_the_version_it_named_and_the_bundles_in_table_order() {
        let known: [&'static str; 2] = ["2026-01-01.v0", roles::NOTICE_VERSION];
        let older = parse_screen_notice_against(
            &claim_body(
                json!(["memory", "files"]),
                json!("2026-01-01.v0"),
                json!("onboarding"),
            ),
            &known,
        )
        .expect("an older wording the server still lists");
        assert_eq!(
            older.notice_version(),
            "2026-01-01.v0",
            "the screen's wording, not the newest"
        );
        assert_eq!(
            older.bundles(),
            [roles::FILES, roles::MEMORY],
            "table order, not request order"
        );
        assert_eq!(older.screen(), ScreenNotice::Onboarding);
        let newest = parse_screen_notice_against(
            &claim_body(
                json!(["memory"]),
                json!(roles::NOTICE_VERSION),
                json!("settings"),
            ),
            &known,
        )
        .unwrap();
        assert_eq!(newest.notice_version(), roles::NOTICE_VERSION);
        assert_eq!(newest.bundles(), [roles::MEMORY]);
        assert_eq!(newest.screen(), ScreenNotice::Settings);
        // The real list takes the real wording.
        assert!(parse_screen_notice(&claim_body(
            json!(["files"]),
            json!(roles::NOTICE_VERSION),
            json!("settings")
        ))
        .is_ok());
    }

    /// #5040: a claim about something the server does not know is a 400, whichever field is wrong.
    #[test]
    fn a_claim_naming_something_unknown_is_refused_field_by_field() {
        let good = |bundles: Value, version: Value, via: Value| claim_body(bundles, version, via);
        let version = json!(roles::NOTICE_VERSION);
        let refused: Vec<(&str, Value, NoticeClaimInvalid)> = vec![
            ("not an object", json!("files"), NoticeClaimInvalid::Shape),
            ("an array", json!(["files"]), NoticeClaimInvalid::Shape),
            (
                "a field a screen has no business sending",
                json!({"bundles": ["files"], "noticeVersion": roles::NOTICE_VERSION,
                       "via": "settings", "approvalId": "00000000-0000-0000-0000-000000000001"}),
                NoticeClaimInvalid::UnknownField("approvalId".into()),
            ),
            (
                "via is a card",
                good(json!(["files"]), version.clone(), json!("card")),
                NoticeClaimInvalid::Via,
            ),
            (
                "via has another case",
                good(json!(["files"]), version.clone(), json!("Settings")),
                NoticeClaimInvalid::Via,
            ),
            (
                "via is a number",
                good(json!(["files"]), version.clone(), json!(1)),
                NoticeClaimInvalid::Via,
            ),
            (
                "a wording the server never shipped",
                good(json!(["files"]), json!("2099-01-01.v9"), json!("settings")),
                NoticeClaimInvalid::Version,
            ),
            (
                "an empty wording",
                good(json!(["files"]), json!(""), json!("settings")),
                NoticeClaimInvalid::Version,
            ),
            (
                "a wording that is a number",
                good(json!(["files"]), json!(20261101), json!("settings")),
                NoticeClaimInvalid::Version,
            ),
            (
                "no bundles",
                good(json!([]), version.clone(), json!("settings")),
                NoticeClaimInvalid::Bundles,
            ),
            (
                "bundles is not a list",
                good(json!("files"), version.clone(), json!("settings")),
                NoticeClaimInvalid::Bundles,
            ),
            (
                "a bundle named twice",
                good(
                    json!(["files", "files"]),
                    version.clone(),
                    json!("settings"),
                ),
                NoticeClaimInvalid::Bundles,
            ),
            (
                "a bundle that is not a string",
                good(json!([7]), version.clone(), json!("settings")),
                NoticeClaimInvalid::Bundles,
            ),
            (
                "more names than there are bundles",
                good(
                    json!(["files", "memory", "code", "x", "y", "z", "w"]),
                    version.clone(),
                    json!("settings"),
                ),
                NoticeClaimInvalid::Bundles,
            ),
            (
                "a bundle with no notice",
                good(json!(["code"]), version.clone(), json!("settings")),
                NoticeClaimInvalid::UnknownBundle("code".into()),
            ),
            (
                "chat_read is no switch",
                good(json!(["chat_read"]), version.clone(), json!("settings")),
                NoticeClaimInvalid::UnknownBundle("chat_read".into()),
            ),
            (
                "a typo",
                good(
                    json!(["files", "filez"]),
                    version.clone(),
                    json!("settings"),
                ),
                NoticeClaimInvalid::UnknownBundle("filez".into()),
            ),
        ];
        for (what, body, expected) in refused {
            assert_eq!(parse_screen_notice(&body), Err(expected), "{what}: {body}");
        }
        // A field that is simply missing is refused as the field it is.
        assert_eq!(
            parse_screen_notice(
                &json!({"noticeVersion": roles::NOTICE_VERSION, "via": "settings"})
            ),
            Err(NoticeClaimInvalid::Bundles)
        );
        assert_eq!(
            parse_screen_notice(&json!({"bundles": ["files"], "via": "settings"})),
            Err(NoticeClaimInvalid::Version)
        );
        assert_eq!(
            parse_screen_notice(
                &json!({"bundles": ["files"], "noticeVersion": roles::NOTICE_VERSION})
            ),
            Err(NoticeClaimInvalid::Via)
        );
    }

    /// #5040: the claim is lifted out of the settings body, so the bag logic never sees it; an
    /// older client's body (no field) is left exactly as it was.
    #[test]
    fn the_claim_is_lifted_out_of_the_settings_body_and_an_absent_one_changes_nothing() {
        let mut body = json!({
            "team_ai_roles": {"files": true},
            SCREEN_NOTICE_FIELD: claim_body(json!(["files"]), json!(roles::NOTICE_VERSION), json!("settings")),
        });
        let claim = take_screen_notice(&mut body).unwrap().expect("a claim");
        assert_eq!(claim.bundles(), [roles::FILES]);
        assert_eq!(
            body,
            json!({"team_ai_roles": {"files": true}}),
            "only the setting is left"
        );
        // The bag merge accepts what is left (the key is not an allowlisted setting).
        assert!(momo_settings::merge_workspace_settings(&json!({}), &body).is_ok());

        let mut older = json!({"team_ai_roles": {"files": true}});
        assert_eq!(take_screen_notice(&mut older), Ok(None));
        assert_eq!(older, json!({"team_ai_roles": {"files": true}}));
        let mut null = json!({SCREEN_NOTICE_FIELD: null, "team_ai_web_search": false});
        assert_eq!(take_screen_notice(&mut null), Ok(None));
        assert_eq!(
            null,
            json!({"team_ai_web_search": false}),
            "null is lifted too, never stored"
        );
        let mut not_an_object = json!(["files"]);
        assert_eq!(take_screen_notice(&mut not_an_object), Ok(None));
        let mut bad = json!({SCREEN_NOTICE_FIELD: {"bundles": ["code"]}});
        assert!(take_screen_notice(&mut bad).is_err());
        // The notice field is not a setting: it never joins the allowlist.
        assert!(!momo_settings::ALLOWED_SETTINGS_KEYS.contains(&SCREEN_NOTICE_FIELD));
    }

    /// A screen's record names the screen's wording; a card's names the server's.
    #[test]
    fn a_record_quotes_the_wording_its_writer_names() {
        let workspace = Uuid::from_u128(1);
        let admin = Uuid::from_u128(2);
        let older = notice_entry(
            workspace,
            admin,
            None,
            &[roles::FILES],
            NoticeSource::Screen(ScreenNotice::Settings),
            "2026-01-01.v0",
        )
        .unwrap();
        assert_eq!(older.detail["notice_version"], "2026-01-01.v0");
        let card =
            card_notice_audit(workspace, admin, None, &[roles::FILES], Uuid::from_u128(9)).unwrap();
        assert_eq!(card.detail["notice_version"], roles::NOTICE_VERSION);
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
    /// is filtered by these names, and a name that matches no tool filters nothing. (`long_research`
    /// owns `task_continue` since #4967; each later slice that adds a name runs into this guard.)
    #[test]
    fn every_bundle_tool_name_is_a_tool_the_helper_can_be_offered() {
        let mut known: Vec<&str> = crate::team_ai_tools::read_tool_definitions()
            .iter()
            .map(|tool| tool.name)
            .collect();
        known.push(momo_agent::tools::WORKSPACE_ACTION_PROPOSE);
        // The task-mode tool is defined next to the proposal tool, outside the catalog.
        known.push(momo_agent::tools::task_continue_definition().name);
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
