//! The team AI's aliases follow its display name — ADR-0201 증보 2026-10-31 v3 B10 (#4966).
//!
//! The helper (「oort 도우미」) is called by its handle `@oort-helper`, by its display name
//! `@oort 도우미`, and by up to four **aliases** (`member_handle_alias`, v2 H2). The first
//! three are fixed (`oort`, `오르트`, `claude`). When an administrator renames the helper, the
//! name gives one more:
//!
//! * `alias_norm = lower(NFC(name))`, shaped `[a-z0-9_가-힣-]{2,16}`. A name with a space (or any
//!   other character the shape rejects) gives **no** alias and is recorded as `not_derivable`;
//!   `@표시 이름` still calls the helper.
//! * The alias is **added**. The fixed three and the aliases of earlier names stay.
//! * A workspace holds at most [`MAX_TEAM_AI_ALIASES`] (4). Adding a fifth removes the **oldest**
//!   first, one at a time — `created_at` order, and among the fixed three that share one instant
//!   `claude` → `오르트` → `oort` (the AI company's name before the product's). Each removal is
//!   audited as `team_ai.alias.released` with the reason `evicted`.
//! * A name whose alias already exists changes nothing.
//! * A live member's **handle** that reads the same wins: the alias is not registered (`taken`).
//!   A member whose **display name** reads the same does not block it: it is registered with a
//!   `display_name_match` warning. The words in [`crate::name_guard::RESERVED_MENTION_WORDS`] are
//!   never aliases.
//!
//! The one entry point is [`sync_team_ai_aliases_in_tx`]. [`crate::rename_agent_display_name_in_tx`]
//! — the single write of an agent's display name, shared by the settings route and the approved
//! `agent.rename` / `agent.profile.update` cards — calls it **in the same transaction**, so the
//! name and its alias commit or roll back together, whichever door the rename came through. The
//! function lives in this crate rather than next to the team AI's other code because that crate
//! depends on this one, not the other way round.
//!
//! The database holds the same line without the app: migration 166's trigger
//! `member_handle_alias_guard` refuses an alias for anyone but the helper and a fifth alias in a
//! workspace, so a statement that skips this module cannot break either rule.

use std::collections::BTreeSet;

use momo_db::audit::{write_audit, AuditEntry};
use momo_db::DbError;
use serde_json::{json, Map, Value};
use sqlx::PgConnection;
use unicode_normalization::UnicodeNormalization as _;
use uuid::Uuid;

use crate::name_guard::is_reserved_mention_word;

/// ADR-0201 증보 v2 H2-2: the three names that always call the team AI (when no live member's
/// handle holds them). v3 B10 adds one more alias per name, up to [`MAX_TEAM_AI_ALIASES`].
pub const TEAM_AI_ALIASES: [&str; 3] = ["oort", "오르트", "claude"];
/// v3 B10-3: aliases one workspace may hold. The trigger on `member_handle_alias` says the same.
pub const MAX_TEAM_AI_ALIASES: usize = 4;

/// The operator switch (`workspace.settings`, writable by the settings PATCH).
pub const SETTINGS_FLAG_KEY: &str = "team_ai_fast_path";
/// The team AI's member id. **Server-written only** — not in the PATCH allow-list, so an operator
/// cannot nominate an arbitrary agent as the proposer (and, from migration 166, as an alias owner).
pub const SETTINGS_MEMBER_KEY: &str = "team_ai_agent_member_id";
/// H2-3: what became of each alias, `{"oort":"registered","claude":"taken",…}`.
/// **Server-written only** — not in the PATCH allow-list.
///
/// Keys are aliases, with one exception: [`STATUS_NAME_KEY`] says what the helper's *current
/// display name* gave when it gave no alias.
pub const SETTINGS_ALIAS_STATUS_KEY: &str = "team_ai_alias_status";
/// The status entry for a display name that gave no alias: `not_derivable` or `reserved`.
/// `@` cannot occur in an alias, so the key can never collide with one.
pub const STATUS_NAME_KEY: &str = "@name";

/// The audit row for an alias that went away (the `member` trigger writes it with the reason
/// `handle_taken`; the eviction here writes it with `evicted`).
pub const AUDIT_ALIAS_RELEASED: &str = "team_ai.alias.released";
pub const AUDIT_ALIAS_SCHEMA: &str = "momo.team_ai_alias.v1";
pub const RELEASE_REASON_EVICTED: &str = "evicted";

/// One alias's state in `team_ai_alias_status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AliasStatus {
    /// The alias calls the team AI.
    Registered,
    /// A live member already holds that **handle** (or the alias row belongs to
    /// someone else): not registered — an alias never takes a real member's name.
    Taken,
    /// Registered, but some member's display name reads the same. The settings
    /// screen says so; the judgement itself is by handle only (H2-3).
    DisplayNameMatch,
}

impl AliasStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AliasStatus::Registered => "registered",
            AliasStatus::Taken => "taken",
            AliasStatus::DisplayNameMatch => "display_name_match",
        }
    }
}

/// A display name that gives no alias (a space, a character outside the alias alphabet, or a
/// length outside 2..=16).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotDerivable;

/// The alias a display name asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedAlias {
    /// NFC, trimmed, as typed (`alias` column).
    pub spelling: String,
    /// `lower(NFC(name))` (`alias_norm` column) — what a mention is matched on.
    pub norm: String,
}

fn is_alias_char(c: char) -> bool {
    matches!(c, 'a'..='z' | '0'..='9' | '_' | '-' | '가'..='힣')
}

/// B10-3: the alias of a display name — `lower(NFC(name))` when that is `[a-z0-9_가-힣-]{2,16}`.
/// The same normal form the client uses for `normalizeAlias`, and the shape the table's CHECK
/// (`member_handle_alias_shape_ck`) enforces.
pub fn derive_alias(display_name: &str) -> Result<DerivedAlias, NotDerivable> {
    let nfc: String = display_name.nfc().collect();
    let spelling = nfc.trim().to_string();
    let norm = spelling.to_lowercase();
    let length = norm.chars().count();
    if (2..=16).contains(&length) && norm.chars().all(is_alias_char) {
        Ok(DerivedAlias { spelling, norm })
    } else {
        Err(NotDerivable)
    }
}

/// What a sync did about the alias a display name asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameAlias {
    /// The alias was added.
    Registered(String),
    /// Added, but another member's display name reads the same (a warning).
    DisplayNameMatch(String),
    /// The alias was already there: nothing changed.
    AlreadyRegistered(String),
    /// A live member's handle holds it: not registered.
    Taken(String),
    /// The name has no alias form.
    NotDerivable,
    /// The alias is one of the reserved words.
    Reserved,
}

impl NameAlias {
    pub fn as_str(&self) -> &'static str {
        match self {
            NameAlias::Registered(_) => "registered",
            NameAlias::DisplayNameMatch(_) => "display_name_match",
            NameAlias::AlreadyRegistered(_) => "already_registered",
            NameAlias::Taken(_) => "taken",
            NameAlias::NotDerivable => "not_derivable",
            NameAlias::Reserved => "reserved",
        }
    }

    pub fn alias(&self) -> Option<&str> {
        match self {
            NameAlias::Registered(alias)
            | NameAlias::DisplayNameMatch(alias)
            | NameAlias::AlreadyRegistered(alias)
            | NameAlias::Taken(alias) => Some(alias),
            NameAlias::NotDerivable | NameAlias::Reserved => None,
        }
    }
}

/// The result of one [`sync_team_ai_aliases_in_tx`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AliasSync {
    pub name: NameAlias,
    /// Aliases removed to make room, oldest first (each is audited as `evicted`).
    pub evicted: Vec<String>,
}

impl AliasSync {
    /// B10-6: what the `member.renamed` audit row adds — alias names and states only.
    pub fn audit_detail(&self) -> Value {
        let mut detail = Map::new();
        detail.insert("state".into(), json!(self.name.as_str()));
        if let Some(alias) = self.name.alias() {
            detail.insert("alias".into(), json!(alias));
        }
        detail.insert("evicted".into(), json!(self.evicted));
        Value::Object(detail)
    }
}

/// The switch and the member, as the alias code reads them from `workspace.settings`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeamAiMember {
    pub member_id: Option<Uuid>,
    pub enabled: bool,
}

pub async fn read_team_ai_member_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<TeamAiMember, DbError> {
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
            .bind(workspace_id)
            .fetch_optional(&mut *conn)
            .await?;
    let settings = settings.unwrap_or(Value::Null);
    Ok(TeamAiMember {
        member_id: settings
            .get(SETTINGS_MEMBER_KEY)
            .and_then(Value::as_str)
            .and_then(|raw| Uuid::parse_str(raw).ok()),
        enabled: settings
            .get(SETTINGS_FLAG_KEY)
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Is `member_id` this workspace's team AI (the switch may be on or off)?
pub async fn is_team_ai_member_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    Ok(read_team_ai_member_in_tx(conn, workspace_id)
        .await?
        .member_id
        == Some(member_id))
}

/// Serialise alias writes within a workspace for the length of the transaction. The trigger on
/// `member_handle_alias` takes the same key before it counts, so two transactions cannot each see
/// three aliases and both add one.
pub async fn lock_aliases_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('team-ai-alias:' || $1::text, 0))")
        .bind(workspace_id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// [`lock_aliases_in_tx`] when `member_id` is this workspace's team AI, and nothing otherwise. For a
/// caller that has to lock the member row itself before it can call
/// [`crate::rename_agent_display_name_in_tx`]: the alias lock comes first, as everywhere else.
pub async fn lock_aliases_if_team_ai_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<(), DbError> {
    if is_team_ai_member_in_tx(conn, workspace_id, member_id).await? {
        lock_aliases_in_tx(conn, workspace_id).await?;
    }
    Ok(())
}

/// The workspace's aliases, **oldest first**: `created_at`, and among aliases of one instant the
/// fixed three in the order they are given up — `claude`, `오르트`, `oort` — then the rest by name.
async fn aliases_oldest_first_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Vec<String>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT alias_norm FROM member_handle_alias \
          WHERE workspace_id = $1 \
          ORDER BY created_at ASC, \
                   CASE alias_norm WHEN 'claude' THEN 0 WHEN '오르트' THEN 1 WHEN 'oort' THEN 2 \
                        ELSE 3 END ASC, \
                   alias_norm COLLATE \"C\" ASC",
    )
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?)
}

/// `team_ai_alias_status` after a sync: the old entries that still describe something, plus what
/// this sync found.
///
/// * an entry survives while its alias still has a row, or while it is one of the fixed three
///   that was `taken` (those have no row by definition);
/// * [`STATUS_NAME_KEY`] describes the *previous* name, so it never survives;
/// * a `taken` entry for an earlier name's alias goes (the name moved on);
/// * an alias that was evicted loses its entry — the settings screen and the helper's own
///   `read_workspace_settings` must not call a name callable that is not.
pub fn next_alias_status(old: &Value, rows: &BTreeSet<String>, outcome: &NameAlias) -> Value {
    let mut next = Map::new();
    if let Some(old) = old.as_object() {
        for (key, state) in old {
            if key == STATUS_NAME_KEY {
                continue;
            }
            let fixed_and_taken =
                TEAM_AI_ALIASES.contains(&key.as_str()) && state.as_str() == Some("taken");
            if rows.contains(key) || fixed_and_taken {
                next.insert(key.clone(), state.clone());
            }
        }
    }
    let put = |next: &mut Map<String, Value>, key: &str, state: &str| {
        next.insert(key.to_string(), Value::String(state.to_string()));
    };
    match outcome {
        NameAlias::Registered(alias) => put(&mut next, alias, "registered"),
        NameAlias::DisplayNameMatch(alias) => put(&mut next, alias, "display_name_match"),
        // Nothing changed: keep what the entry says, and only fill a missing one.
        NameAlias::AlreadyRegistered(alias) => {
            if !next.contains_key(alias) {
                put(&mut next, alias, "registered");
            }
        }
        NameAlias::Taken(alias) => put(&mut next, alias, "taken"),
        NameAlias::NotDerivable => put(&mut next, STATUS_NAME_KEY, "not_derivable"),
        NameAlias::Reserved => put(&mut next, STATUS_NAME_KEY, "reserved"),
    }
    Value::Object(next)
}

/// Make the team AI's aliases follow `display_name` (B10-3), in the caller's transaction.
///
/// `Ok(None)` when `member_id` is not this workspace's team AI, or the switch is off (off means no
/// alias calls anybody, H2-5) — nothing is read further and nothing is written. Otherwise the
/// alias the name asks for is added (making room first if the workspace already holds four),
/// `team_ai_alias_status` is brought up to date, and the outcome is returned for the caller's
/// audit row.
///
/// The caller holds the helper's `member` row (`FOR UPDATE`) while it renames; the advisory lock
/// taken here orders this against any other alias write in the workspace.
pub async fn sync_team_ai_aliases_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    display_name: &str,
) -> Result<Option<AliasSync>, DbError> {
    // The lock first, the switch second: a switch-off that commits while this waits is seen, so
    // an alias is never added behind its back (H2-5). The switch-on and switch-off paths take the
    // same lock before they touch anything else, so the lock order is the same everywhere.
    lock_aliases_in_tx(conn, workspace_id).await?;
    let team = read_team_ai_member_in_tx(conn, workspace_id).await?;
    if team.member_id != Some(member_id) || !team.enabled {
        return Ok(None);
    }

    let mut evicted: Vec<String> = Vec::new();
    let name = match derive_alias(display_name) {
        Err(NotDerivable) => NameAlias::NotDerivable,
        Ok(derived) if is_reserved_mention_word(&derived.norm) => NameAlias::Reserved,
        Ok(derived) => {
            let held = aliases_oldest_first_in_tx(conn, workspace_id).await?;
            if held.contains(&derived.norm) {
                NameAlias::AlreadyRegistered(derived.norm)
            } else if handle_is_taken_in_tx(conn, workspace_id, &derived.norm).await? {
                NameAlias::Taken(derived.norm)
            } else {
                // Make room first, oldest first, one at a time: the trigger refuses a fifth row.
                let mut held = held;
                while held.len() >= MAX_TEAM_AI_ALIASES {
                    let oldest = held.remove(0);
                    sqlx::query(
                        "DELETE FROM member_handle_alias WHERE workspace_id = $1 AND alias_norm = $2",
                    )
                    .bind(workspace_id)
                    .bind(&oldest)
                    .execute(&mut *conn)
                    .await?;
                    write_audit(
                        conn,
                        &AuditEntry::new(workspace_id, AUDIT_ALIAS_RELEASED)
                            .about(member_id)
                            .target("member", member_id)
                            .with_schema(
                                AUDIT_ALIAS_SCHEMA,
                                json!({ "alias": oldest, "reason": RELEASE_REASON_EVICTED }),
                            ),
                    )
                    .await?;
                    evicted.push(oldest);
                }
                // `clock_timestamp()`, not the column default `now()` (the transaction's start):
                // the new alias must be strictly newer than the fixed three even when this
                // transaction is the one that registered them (a re-enable after a rename).
                sqlx::query(
                    "INSERT INTO member_handle_alias \
                       (workspace_id, member_id, alias, alias_norm, created_at) \
                     VALUES ($1, $2, $3, $4, clock_timestamp())",
                )
                .bind(workspace_id)
                .bind(member_id)
                .bind(&derived.spelling)
                .bind(&derived.norm)
                .execute(&mut *conn)
                .await?;
                if display_name_is_taken_in_tx(conn, workspace_id, member_id, &derived.norm).await?
                {
                    NameAlias::DisplayNameMatch(derived.norm)
                } else {
                    NameAlias::Registered(derived.norm)
                }
            }
        }
    };

    let rows: BTreeSet<String> = aliases_oldest_first_in_tx(conn, workspace_id)
        .await?
        .into_iter()
        .collect();
    let old: Value = sqlx::query_scalar(
        "SELECT COALESCE(settings -> 'team_ai_alias_status', '{}'::jsonb) \
           FROM workspace WHERE id = $1",
    )
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;
    let next = next_alias_status(&old, &rows, &name);
    if next != old {
        write_alias_status_in_tx(conn, workspace_id, &next).await?;
    }
    Ok(Some(AliasSync { name, evicted }))
}

/// Replace `workspace.settings.team_ai_alias_status` (server-written; not PATCH-able).
pub async fn write_alias_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    status: &Value,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE workspace SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), $2, $3, true), \
                updated_at = now() \
          WHERE id = $1",
    )
    .bind(workspace_id)
    .bind(vec![SETTINGS_ALIAS_STATUS_KEY.to_string()])
    .bind(status)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// H2-3: does a live member's **handle** already read as `alias`? A handle is unique and chosen at
/// sign-up, so it — not a display name — decides who wins.
pub async fn handle_is_taken_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    alias: &str,
) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member \
                         WHERE workspace_id = $1 AND deleted_at IS NULL \
                           AND lower(handle) = $2)",
    )
    .bind(workspace_id)
    .bind(alias)
    .fetch_one(&mut *conn)
    .await?)
}

/// H2-3: does another live member's display name read as `alias`? (A warning, not a refusal.)
pub async fn display_name_is_taken_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    team_ai_member_id: Uuid,
    alias: &str,
) -> Result<bool, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM member \
                         WHERE workspace_id = $1 AND deleted_at IS NULL \
                           AND id <> $2 AND lower(btrim(display_name)) = $3)",
    )
    .bind(workspace_id)
    .bind(team_ai_member_id)
    .bind(alias)
    .fetch_one(&mut *conn)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    /// B10-3: the shape is the table's CHECK, and the form is `lower(NFC(name))`.
    #[test]
    fn a_name_gives_an_alias_only_in_the_alias_shape() {
        for (name, norm) in [
            ("별무리", "별무리"),
            ("Bob", "bob"),
            ("  Bob  ", "bob"),
            ("도우미A", "도우미a"),
            ("my_bot-2", "my_bot-2"),
            ("ab", "ab"),
            (
                "가나다라마바사아자차카타파하가나",
                "가나다라마바사아자차카타파하가나",
            ),
            // NFC: a decomposed syllable (ㅂ + ㅣ) is the same alias as the composed one.
            ("\u{1107}\u{1175}서", "비서"),
        ] {
            let derived = derive_alias(name).unwrap_or_else(|_| panic!("{name:?} derives"));
            assert_eq!(derived.norm, norm, "{name:?}");
        }
        for name in [
            "oort 도우미", // a space
            "두 단어",
            "a",                                  // too short
            "가나다라마바사아자차카타파하가나다", // 17 characters
            "Bob!",
            "bob.",
            "ＡＢ", // full-width letters are not in the alphabet
            "🤖봇",
            "",
            "   ",
        ] {
            assert_eq!(derive_alias(name), Err(NotDerivable), "{name:?}");
        }
        // The spelling keeps the case the administrator typed.
        assert_eq!(derive_alias("Bob").unwrap().spelling, "Bob");
    }

    #[test]
    fn the_status_follows_the_aliases_that_exist() {
        // Fresh: nothing in the way, a new alias is registered next to the fixed three.
        let old = json!({"oort": "registered", "오르트": "registered", "claude": "registered"});
        let next = next_alias_status(
            &old,
            &rows(&["oort", "오르트", "claude", "비서"]),
            &NameAlias::Registered("비서".into()),
        );
        assert_eq!(
            next,
            json!({"oort": "registered", "오르트": "registered", "claude": "registered", "비서": "registered"})
        );

        // An evicted alias loses its entry; a `taken` fixed one (no row) keeps it.
        let old = json!({"oort": "registered", "오르트": "registered", "claude": "taken", "비서": "registered"});
        let next = next_alias_status(
            &old,
            &rows(&["oort", "오르트", "비서", "봇"]),
            &NameAlias::Registered("봇".into()),
        );
        assert_eq!(
            next,
            json!({"oort": "registered", "오르트": "registered", "claude": "taken", "비서": "registered", "봇": "registered"})
        );
        let next = next_alias_status(
            &json!({"oort": "registered", "claude": "registered"}),
            &rows(&["oort"]),
            &NameAlias::Registered("봇".into()),
        );
        assert!(next.get("claude").is_none(), "evicted: {next}");

        // A name with no alias leaves the others alone and says why under the reserved key —
        // and the next name takes that note away.
        let base = json!({"oort": "registered", "오르트": "registered", "claude": "registered"});
        let all = rows(&["oort", "오르트", "claude"]);
        let spaced = next_alias_status(&base, &all, &NameAlias::NotDerivable);
        assert_eq!(spaced["@name"], json!("not_derivable"));
        assert_eq!(spaced["oort"], json!("registered"));
        assert_eq!(
            next_alias_status(&spaced, &all, &NameAlias::Reserved)["@name"],
            json!("reserved")
        );
        let after = next_alias_status(&spaced, &all, &NameAlias::AlreadyRegistered("oort".into()));
        assert!(after.get("@name").is_none(), "{after}");
        assert_eq!(after, base);

        // `taken` for an earlier name's alias does not outlive that name.
        let stale = json!({"oort": "registered", "밥": "taken"});
        let next = next_alias_status(&stale, &rows(&["oort"]), &NameAlias::Taken("톰".into()));
        assert_eq!(next, json!({"oort": "registered", "톰": "taken"}));

        // Nothing changed for an alias that was already there: its warning is not rewritten.
        let warned = json!({"oort": "display_name_match"});
        assert_eq!(
            next_alias_status(
                &warned,
                &rows(&["oort"]),
                &NameAlias::AlreadyRegistered("oort".into())
            ),
            warned
        );
    }

    #[test]
    fn the_audit_detail_names_aliases_and_states_only() {
        let sync = AliasSync {
            name: NameAlias::Registered("비서".into()),
            evicted: vec!["claude".into()],
        };
        assert_eq!(
            sync.audit_detail(),
            json!({"state": "registered", "alias": "비서", "evicted": ["claude"]})
        );
        let none = AliasSync {
            name: NameAlias::NotDerivable,
            evicted: Vec::new(),
        };
        assert_eq!(
            none.audit_detail(),
            json!({"state": "not_derivable", "evicted": []})
        );
    }
}
