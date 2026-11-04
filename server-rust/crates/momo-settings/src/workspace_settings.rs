//! `workspace.settings` bag — operator GET/PATCH domain (#1800, #1770).
//!
//! The column already exists (`schema_v0.sql`). This module is the only writer
//! that goes through REST: top-level RFC 7396 merge, a closed allowlist, and
//! hard size caps. Semantics of a stored key stay with the helper that already
//! reads it (`momo_agent::allowed_agent_models`) or the identity projection
//! (`project_role_labels`). Merge is top-level only: nested objects such as
//! `role_labels` are replaced whole, not deep-merged.

use momo_db::DbError;
use serde_json::{json, Map, Value};
use sqlx::PgConnection;
use uuid::Uuid;

/// Writable top-level keys. `role_labels` is display-only — it never changes
/// `is_admin` / `can_*` / RLS / the role wire value.
pub const ALLOWED_SETTINGS_KEYS: &[&str] = &[
    "allowed_agent_models",
    "role_labels",
    "welcome_agent_member_id",
    "welcome_prompt",
    // ADR-0201 D8: the team-AI fast-path switch. A bool; the route that stores it
    // also provisions/pauses the member. The member id is server-written and is
    // deliberately NOT here.
    "team_ai_fast_path",
    // ADR-0201 증보 v2 H5: the helper's provider-side web search (absent = on).
    // `team_ai_alias_status` is server-written and deliberately NOT here.
    "team_ai_web_search",
    // ADR-0186 증보 v5 U-b-3 (#4704): the switch for cards an agent raises nobody asked for
    // (absent = on). A bool, written by an administrator through `PATCH …/settings` — and
    // deliberately **not** by an agent: `workspace.settings.update` takes two other keys
    // (`welcomePrompt`, `roleLabels`), so no proposal can flip the switch that bounds proposals.
    // `momo_agent::initiative::SETTING_AGENT_INITIATIVE` spells the same key for the reader.
    "agent_initiative",
    // ADR-0201 증보 v3 B3 (#4964): which role bundles of the team AI are on. An object of
    // booleans keyed by `TEAM_AI_ROLES_KEYS`; absent key or field = on. Written by an
    // administrator here, or by the admin-approved card `team_ai.roles.set` — and
    // deliberately **not** by an agent's `workspace.settings.update`, which names two other
    // keys (B13-I9). `momo_agent::team_ai_roles::SETTINGS_KEY` spells the same key for the reader.
    "team_ai_roles",
    // ADR-0201 증보 v3 B9 (#4944): the team AI's usage limits. Absent = **no limit** (BYOK: the
    // team pays, the team decides). An object of up to three limits — `dailyTokens` and
    // `dailySearches` (whole numbers >= 1), `monthlyUsd` (a number > 0). Written by a workspace
    // administrator here and nowhere else: `workspace.settings.update` names two other keys, so a
    // helper's card cannot raise the limit that bounds the helper (B13-I9).
    "team_ai_limits",
];

/// The six role bundles that can be switched (`chat_read` is not one: it is always on). A copy of
/// `momo_agent::team_ai_roles::SWITCHABLE_BUNDLES` — this crate cannot see `momo-agent` — held
/// equal by a drift test in `momo-workspace-actions`.
pub const TEAM_AI_ROLES_KEYS: [&str; 6] = [
    "workspace_admin",
    "invite_access",
    "long_research",
    "files",
    "memory",
    "code",
];

/// The settings key of the role switches.
pub const TEAM_AI_ROLES_SETTING: &str = "team_ai_roles";

/// The settings key of the usage limits (ADR-0201 증보 v3 B9, #4944). The reader
/// (`momo_workspace_actions::team_ai_limits`) spells its fields from the constants below.
pub const TEAM_AI_LIMITS_SETTING: &str = "team_ai_limits";
/// Tokens (prompt + completion) the team AI may spend per UTC day. A whole number >= 1.
pub const TEAM_AI_LIMIT_DAILY_TOKENS: &str = "dailyTokens";
/// Provider-side web searches the team AI may make per UTC day. A whole number >= 1.
pub const TEAM_AI_LIMIT_DAILY_SEARCHES: &str = "dailySearches";
/// Dollars (public list price equivalent, read-time) per UTC calendar month. A number > 0.
pub const TEAM_AI_LIMIT_MONTHLY_USD: &str = "monthlyUsd";
/// The three fields, in the order the screen shows them.
pub const TEAM_AI_LIMIT_FIELDS: [&str; 3] = [
    TEAM_AI_LIMIT_DAILY_TOKENS,
    TEAM_AI_LIMIT_DAILY_SEARCHES,
    TEAM_AI_LIMIT_MONTHLY_USD,
];
/// A sanity ceiling on a count limit, so a typo does not store a number nobody can reach.
pub const MAX_TEAM_AI_LIMIT_COUNT: i64 = 1_000_000_000_000;
/// A sanity ceiling on `monthlyUsd` — the same one a shared agent's monthly fee has
/// (ADR-0147 증보 2026-10-30 D5).
pub const MAX_TEAM_AI_LIMIT_USD: f64 = 1_000_000.0;
/// The smallest dollar amount that is still a limit: one micro-dollar, the unit the ledger's
/// read-time cost is counted in. A positive number that rounds to zero would be "already over".
pub const MIN_TEAM_AI_LIMIT_USD: f64 = 0.000_001;

/// Human membership roles that may carry a display override. Agent labels are
/// a client `null` rule and are refused here.
pub const ROLE_LABEL_KEYS: &[&str] = &["owner", "admin", "member", "guest"];

/// UTF-8 byte cap for one role display string. 48 bytes covers Korean labels.
pub const MAX_ROLE_LABEL_BYTES: usize = 48;

/// Serialized PATCH body cap. Aligns with other JSON settings writes: far below
/// Axum's 2 MiB default so jsonb cannot be used as an unbounded dump.
pub const MAX_WORKSPACE_SETTINGS_JSON_BYTES: usize = 8_192;

/// Upper bound on `allowed_agent_models` entries.
pub const MAX_ALLOWED_AGENT_MODELS: usize = 32;

/// Upper bound on one model id, bytes not chars — model ids are ASCII.
pub const MAX_ALLOWED_AGENT_MODEL_BYTES: usize = 64;

/// ADR-0181 D8: welcome prompt character cap (proof ⑦ is 2001 chars → 400).
pub const MAX_WELCOME_PROMPT_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkspaceSettingsInvalid {
    #[error("settings patch must be a JSON object")]
    NotAnObject,
    #[error("settings payload is too large")]
    PayloadTooLarge,
    #[error("unknown settings key: {0}")]
    UnknownKey(String),
    #[error("allowed_agent_models must be an array of strings")]
    AllowedAgentModelsShape,
    #[error("allowed_agent_models may hold at most {MAX_ALLOWED_AGENT_MODELS} entries")]
    AllowedAgentModelsCount,
    #[error("allowed_agent_models entry exceeds {MAX_ALLOWED_AGENT_MODEL_BYTES} bytes")]
    AllowedAgentModelsEntryLength,
    #[error("role_labels must be an object of role → non-empty string")]
    RoleLabelsShape,
    #[error("unknown role_labels key: {0}")]
    RoleLabelsUnknownRole(String),
    #[error("role_labels value exceeds {MAX_ROLE_LABEL_BYTES} bytes")]
    RoleLabelsEntryLength,
    #[error("welcome_agent_member_id must be a uuid")]
    WelcomeAgentMemberIdShape,
    #[error("team_ai_fast_path must be true or false")]
    TeamAiFastPathShape,
    #[error("team_ai_web_search must be true or false")]
    TeamAiWebSearchShape,
    #[error("agent_initiative must be true or false")]
    AgentInitiativeShape,
    #[error("team_ai_roles must be an object of bundle → true or false")]
    TeamAiRolesShape,
    #[error("unknown team_ai_roles bundle: {0}")]
    TeamAiRolesUnknownBundle(String),
    #[error("team_ai_limits must be an object of dailyTokens, dailySearches and monthlyUsd")]
    TeamAiLimitsShape,
    #[error("unknown team_ai_limits field: {0}")]
    TeamAiLimitsUnknownField(String),
    #[error("team_ai_limits.{0} must be a whole number of at least 1 (no limit is the absence of the field, not 0)")]
    TeamAiLimitsCount(&'static str),
    #[error("team_ai_limits.monthlyUsd must be a number above 0 and at most 1000000 (no limit is the absence of the field, not 0)")]
    TeamAiLimitsUsd,
    #[error("welcome_prompt must be a string")]
    WelcomePromptShape,
    #[error("welcome_prompt must be at most {MAX_WELCOME_PROMPT_CHARS} characters")]
    WelcomePromptLength,
}

impl WorkspaceSettingsInvalid {
    pub fn is_payload_too_large(&self) -> bool {
        matches!(self, Self::PayloadTooLarge)
    }
}

/// RFC 7396-shaped top-level merge: named keys replace, omitted keys stay,
/// `null` deletes. Unknown keys are refused rather than stored.
pub fn merge_workspace_settings(
    existing: &Value,
    patch: &Value,
) -> Result<Value, WorkspaceSettingsInvalid> {
    let encoded = serde_json::to_vec(patch).unwrap_or_default();
    if encoded.len() > MAX_WORKSPACE_SETTINGS_JSON_BYTES {
        return Err(WorkspaceSettingsInvalid::PayloadTooLarge);
    }
    let Value::Object(patch_map) = patch else {
        return Err(WorkspaceSettingsInvalid::NotAnObject);
    };
    let mut current = match existing {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for (key, value) in patch_map {
        if !ALLOWED_SETTINGS_KEYS.contains(&key.as_str()) {
            return Err(WorkspaceSettingsInvalid::UnknownKey(key.clone()));
        }
        if value.is_null() {
            current.remove(key);
            continue;
        }
        validate_settings_value(key, value)?;
        if key == TEAM_AI_ROLES_SETTING {
            // The one key merged a level down (see [`merge_team_ai_roles`]).
            let merged = merge_team_ai_roles(current.get(key), value);
            current.insert(key.clone(), merged);
            continue;
        }
        if key == TEAM_AI_LIMITS_SETTING {
            // Merged a level down too, for the same reason and a worse failure: a patch that
            // names `dailyTokens` and replaced the object would silently DROP `monthlyUsd` — an
            // edit of one limit lifting another. A limit object with no field left is no limit,
            // so the key goes away rather than staying as an empty shell.
            let merged = merge_team_ai_limits(current.get(key), value);
            if merged.as_object().is_some_and(Map::is_empty) {
                current.remove(key);
            } else {
                current.insert(key.clone(), merged);
            }
            continue;
        }
        current.insert(key.clone(), value.clone());
    }
    Ok(Value::Object(current))
}

fn validate_settings_value(key: &str, value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    match key {
        "allowed_agent_models" => validate_allowed_agent_models(value),
        "role_labels" => validate_role_labels(value),
        "welcome_agent_member_id" => validate_welcome_agent_member_id(value),
        "welcome_prompt" => validate_welcome_prompt(value),
        "team_ai_fast_path" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(WorkspaceSettingsInvalid::TeamAiFastPathShape)
            }
        }
        "team_ai_web_search" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(WorkspaceSettingsInvalid::TeamAiWebSearchShape)
            }
        }
        // A literal boolean or nothing: the door reads anything else as *off* (it fails closed),
        // so a string `"false"` stored here would silently be a switch somebody meant to leave
        // on. Refuse it at the one place a person writes it.
        "agent_initiative" => {
            if value.is_boolean() {
                Ok(())
            } else {
                Err(WorkspaceSettingsInvalid::AgentInitiativeShape)
            }
        }
        TEAM_AI_ROLES_SETTING => validate_team_ai_roles(value),
        TEAM_AI_LIMITS_SETTING => validate_team_ai_limits(value),
        _ => Err(WorkspaceSettingsInvalid::UnknownKey(key.to_string())),
    }
}

/// `team_ai_limits` as PATCH sends it (B9-1): an object whose fields are among
/// [`TEAM_AI_LIMIT_FIELDS`]. A count is a JSON **integer** in `1..=`[`MAX_TEAM_AI_LIMIT_COUNT`]
/// (`1.5`, `"5"`, `true`, `0` and a negative are all 400); `monthlyUsd` is a number in
/// [`MIN_TEAM_AI_LIMIT_USD`]`..=`[`MAX_TEAM_AI_LIMIT_USD`]. A field may be `null` — that drops the
/// limit. `0` is never a limit: switching the helper off is `team_ai_fast_path`'s job (B9-3), and a
/// `0` stored here would read as "already over" on every call.
fn validate_team_ai_limits(value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    let Some(fields) = value.as_object() else {
        return Err(WorkspaceSettingsInvalid::TeamAiLimitsShape);
    };
    for (field, limit) in fields {
        match field.as_str() {
            TEAM_AI_LIMIT_DAILY_TOKENS => validate_limit_count(TEAM_AI_LIMIT_DAILY_TOKENS, limit)?,
            TEAM_AI_LIMIT_DAILY_SEARCHES => {
                validate_limit_count(TEAM_AI_LIMIT_DAILY_SEARCHES, limit)?
            }
            TEAM_AI_LIMIT_MONTHLY_USD => {
                if !limit.is_null() && !valid_limit_usd(limit) {
                    return Err(WorkspaceSettingsInvalid::TeamAiLimitsUsd);
                }
            }
            other => {
                return Err(WorkspaceSettingsInvalid::TeamAiLimitsUnknownField(
                    other.to_string(),
                ))
            }
        }
    }
    Ok(())
}

fn validate_limit_count(
    field: &'static str,
    value: &Value,
) -> Result<(), WorkspaceSettingsInvalid> {
    if value.is_null() {
        return Ok(());
    }
    match value.as_i64() {
        Some(count) if (1..=MAX_TEAM_AI_LIMIT_COUNT).contains(&count) => Ok(()),
        _ => Err(WorkspaceSettingsInvalid::TeamAiLimitsCount(field)),
    }
}

/// A usable `monthlyUsd`: a JSON number, finite, in range. Shared with the reader so a stored value
/// that this would refuse is read as absent rather than as some other limit.
pub fn valid_limit_usd(value: &Value) -> bool {
    value.as_f64().is_some_and(|usd| {
        usd.is_finite() && (MIN_TEAM_AI_LIMIT_USD..=MAX_TEAM_AI_LIMIT_USD).contains(&usd)
    })
}

/// `team_ai_limits` merged **a level down**: a named field replaces, an omitted field stays, a
/// `null` field is dropped. Only the three known fields are carried over from what is stored, so
/// nothing a hand edit left in the object survives the next save. The result holds numbers only.
fn merge_team_ai_limits(existing: Option<&Value>, patch: &Value) -> Value {
    let mut merged = Map::new();
    if let Some(Value::Object(stored)) = existing {
        for field in TEAM_AI_LIMIT_FIELDS {
            if let Some(value) = stored.get(field) {
                merged.insert(field.to_string(), value.clone());
            }
        }
    }
    if let Some(fields) = patch.as_object() {
        for (field, limit) in fields {
            if limit.is_null() {
                merged.remove(field);
            } else {
                merged.insert(field.clone(), limit.clone());
            }
        }
    }
    Value::Object(merged)
}

/// `team_ai_roles` as PATCH sends it: an object whose keys are among [`TEAM_AI_ROLES_KEYS`] and
/// whose values are a literal `true`/`false`, or `null` (drop that field = back to on).
/// `chat_read` is refused with every other unknown name: it is not a switch.
fn validate_team_ai_roles(value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    let Some(fields) = value.as_object() else {
        return Err(WorkspaceSettingsInvalid::TeamAiRolesShape);
    };
    for (bundle, switch) in fields {
        if !TEAM_AI_ROLES_KEYS.contains(&bundle.as_str()) {
            return Err(WorkspaceSettingsInvalid::TeamAiRolesUnknownBundle(
                bundle.clone(),
            ));
        }
        if !(switch.is_boolean() || switch.is_null()) {
            return Err(WorkspaceSettingsInvalid::TeamAiRolesShape);
        }
    }
    Ok(())
}

/// The one key merged **a level down**. Every other nested value is replaced whole, but a patch
/// of `{"files": false}` that replaced the object would flip every bundle it did not name back
/// to *on* (an absent field reads as on) — an edit of one switch silently widening the others.
/// So a named field replaces, an omitted field stays, a `null` field is dropped. The result holds
/// booleans only; `existing` is read only if it is an object.
fn merge_team_ai_roles(existing: Option<&Value>, patch: &Value) -> Value {
    let mut merged = match existing {
        Some(Value::Object(fields)) => fields.clone(),
        _ => Map::new(),
    };
    if let Some(fields) = patch.as_object() {
        for (bundle, switch) in fields {
            if switch.is_null() {
                merged.remove(bundle);
            } else {
                merged.insert(bundle.clone(), switch.clone());
            }
        }
    }
    Value::Object(merged)
}

fn validate_allowed_agent_models(value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    let Some(items) = value.as_array() else {
        return Err(WorkspaceSettingsInvalid::AllowedAgentModelsShape);
    };
    if items.len() > MAX_ALLOWED_AGENT_MODELS {
        return Err(WorkspaceSettingsInvalid::AllowedAgentModelsCount);
    }
    for item in items {
        let Some(model) = item.as_str() else {
            return Err(WorkspaceSettingsInvalid::AllowedAgentModelsShape);
        };
        if model.len() > MAX_ALLOWED_AGENT_MODEL_BYTES {
            return Err(WorkspaceSettingsInvalid::AllowedAgentModelsEntryLength);
        }
    }
    Ok(())
}

fn validate_role_labels(value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    let Some(map) = value.as_object() else {
        return Err(WorkspaceSettingsInvalid::RoleLabelsShape);
    };
    for (key, label) in map {
        if !ROLE_LABEL_KEYS.contains(&key.as_str()) {
            return Err(WorkspaceSettingsInvalid::RoleLabelsUnknownRole(key.clone()));
        }
        let Some(text) = label.as_str() else {
            return Err(WorkspaceSettingsInvalid::RoleLabelsShape);
        };
        if text.trim().is_empty() {
            return Err(WorkspaceSettingsInvalid::RoleLabelsShape);
        }
        if text.len() > MAX_ROLE_LABEL_BYTES {
            return Err(WorkspaceSettingsInvalid::RoleLabelsEntryLength);
        }
    }
    Ok(())
}

fn validate_welcome_agent_member_id(value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    let Some(text) = value.as_str() else {
        return Err(WorkspaceSettingsInvalid::WelcomeAgentMemberIdShape);
    };
    Uuid::parse_str(text)
        .map(|_| ())
        .map_err(|_| WorkspaceSettingsInvalid::WelcomeAgentMemberIdShape)
}

fn validate_welcome_prompt(value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    let Some(text) = value.as_str() else {
        return Err(WorkspaceSettingsInvalid::WelcomePromptShape);
    };
    if text.chars().count() > MAX_WELCOME_PROMPT_CHARS {
        return Err(WorkspaceSettingsInvalid::WelcomePromptLength);
    }
    Ok(())
}

/// Member-readable projection of `settings.role_labels`. Missing or non-object
/// values become `{}`. The rest of the bag is never returned.
pub fn project_role_labels(settings: &Value) -> Value {
    match settings.get("role_labels") {
        Some(Value::Object(_)) => settings["role_labels"].clone(),
        _ => json!({}),
    }
}

/// Read the stored bag, or `None` when RLS hides the workspace row.
pub async fn read_workspace_settings(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<Value>, DbError> {
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
            .bind(workspace_id)
            .fetch_optional(conn)
            .await?;
    Ok(settings)
}

/// PATCH-only read: take the row lock before the app merges.
///
/// Merge happens in-process, so an unlocked read lets two concurrent PATCHes
/// each merge against the same snapshot and the later commit wipes the
/// earlier one's keys.
pub async fn read_workspace_settings_for_update(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<Value>, DbError> {
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1 FOR UPDATE")
            .bind(workspace_id)
            .fetch_optional(conn)
            .await?;
    Ok(settings)
}

/// Replace the stored bag. `updated_at` advances so a later rename token moves.
pub async fn write_workspace_settings(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    settings: &Value,
) -> Result<Option<Value>, DbError> {
    let settings: Option<Value> = sqlx::query_scalar(
        "UPDATE workspace SET settings = $2, updated_at = now() \
          WHERE id = $1 RETURNING settings",
    )
    .bind(workspace_id)
    .bind(settings)
    .fetch_optional(conn)
    .await?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_patch_preserves_existing_keys() {
        let existing = json!({"role_labels": {"owner": "대표"}});
        let merged = merge_workspace_settings(&existing, &json!({})).expect("empty patch");
        assert_eq!(merged, existing);
    }

    #[test]
    fn patch_adds_allowed_key_without_dropping_others() {
        let existing = json!({"role_labels": {"owner": "대표"}});
        let merged = merge_workspace_settings(
            &existing,
            &json!({"allowed_agent_models": ["hermes-agent"]}),
        )
        .expect("merge");
        assert_eq!(merged["allowed_agent_models"], json!(["hermes-agent"]));
        assert_eq!(merged["role_labels"], json!({"owner": "대표"}));
    }

    #[test]
    fn null_deletes_only_the_named_key() {
        let existing = json!({
            "allowed_agent_models": ["hermes-agent"],
            "role_labels": {"owner": "대표"}
        });
        let merged =
            merge_workspace_settings(&existing, &json!({"allowed_agent_models": null})).unwrap();
        assert!(merged.get("allowed_agent_models").is_none());
        assert_eq!(merged["role_labels"], json!({"owner": "대표"}));
    }

    #[test]
    fn unknown_keys_are_refused() {
        assert!(matches!(
            merge_workspace_settings(&json!({}), &json!({"allowedAgentModels": ["x"]})),
            Err(WorkspaceSettingsInvalid::UnknownKey(_))
        ));
        assert!(matches!(
            merge_workspace_settings(&json!({}), &json!({"totally_unknown": true})),
            Err(WorkspaceSettingsInvalid::UnknownKey(_))
        ));
    }

    #[test]
    fn role_labels_are_accepted_and_replaced_whole() {
        let merged = merge_workspace_settings(
            &json!({"role_labels": {"owner": "대표", "admin": "관리자"}}),
            &json!({"role_labels": {"owner": "마스터"}}),
        )
        .unwrap();
        assert_eq!(merged["role_labels"], json!({"owner": "마스터"}));
        assert!(
            merged["role_labels"].get("admin").is_none(),
            "top-level merge replaces the object; omitted role keys drop"
        );
    }

    #[test]
    fn role_labels_null_deletes_the_key() {
        let existing = json!({
            "allowed_agent_models": ["hermes-agent"],
            "role_labels": {"owner": "대표"}
        });
        let merged = merge_workspace_settings(&existing, &json!({"role_labels": null})).unwrap();
        assert!(merged.get("role_labels").is_none());
        assert_eq!(merged["allowed_agent_models"], json!(["hermes-agent"]));
        assert_eq!(project_role_labels(&merged), json!({}));
    }

    #[test]
    fn role_labels_shape_violations_are_refused() {
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": []})),
            Err(WorkspaceSettingsInvalid::RoleLabelsShape)
        );
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": "owner"})),
            Err(WorkspaceSettingsInvalid::RoleLabelsShape)
        );
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": {"owner": ""}})),
            Err(WorkspaceSettingsInvalid::RoleLabelsShape)
        );
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": {"owner": "   "}})),
            Err(WorkspaceSettingsInvalid::RoleLabelsShape)
        );
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": {"owner": 1}})),
            Err(WorkspaceSettingsInvalid::RoleLabelsShape)
        );
        assert!(matches!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": {"hermes": "봇"}})),
            Err(WorkspaceSettingsInvalid::RoleLabelsUnknownRole(key)) if key == "hermes"
        ));
        let too_long = "가".repeat(17); // 51 UTF-8 bytes
        assert!(too_long.len() > MAX_ROLE_LABEL_BYTES);
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": {"owner": too_long}})),
            Err(WorkspaceSettingsInvalid::RoleLabelsEntryLength)
        );
    }

    #[test]
    fn project_role_labels_is_the_one_key_or_empty() {
        assert_eq!(project_role_labels(&json!({})), json!({}));
        assert_eq!(
            project_role_labels(&json!({"allowed_agent_models": ["secret"]})),
            json!({})
        );
        assert_eq!(
            project_role_labels(&json!({"role_labels": {"owner": "대표"}})),
            json!({"owner": "대표"})
        );
        assert_eq!(
            project_role_labels(&json!({"role_labels": "not-an-object"})),
            json!({})
        );
    }

    #[test]
    fn allowed_agent_models_must_be_a_string_array() {
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"allowed_agent_models": "x"})),
            Err(WorkspaceSettingsInvalid::AllowedAgentModelsShape)
        );
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"allowed_agent_models": [1]})),
            Err(WorkspaceSettingsInvalid::AllowedAgentModelsShape)
        );
    }

    #[test]
    fn array_and_entry_caps_are_closed() {
        let too_many: Vec<String> = (0..=MAX_ALLOWED_AGENT_MODELS)
            .map(|i| format!("m{i}"))
            .collect();
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"allowed_agent_models": too_many})),
            Err(WorkspaceSettingsInvalid::AllowedAgentModelsCount)
        );
        let too_long = "m".repeat(MAX_ALLOWED_AGENT_MODEL_BYTES + 1);
        assert_eq!(
            merge_workspace_settings(&json!({}), &json!({"allowed_agent_models": [too_long]})),
            Err(WorkspaceSettingsInvalid::AllowedAgentModelsEntryLength)
        );
    }

    #[test]
    fn oversized_patch_is_payload_too_large() {
        let patch = json!({
            "allowed_agent_models": ["ok"],
            "pad": "x".repeat(MAX_WORKSPACE_SETTINGS_JSON_BYTES)
        });
        assert_eq!(
            merge_workspace_settings(&json!({}), &patch),
            Err(WorkspaceSettingsInvalid::PayloadTooLarge)
        );
    }

    #[test]
    fn empty_allowed_list_is_a_present_key() {
        let merged =
            merge_workspace_settings(&json!({}), &json!({"allowed_agent_models": []})).unwrap();
        assert_eq!(merged, json!({"allowed_agent_models": []}));
    }

    /// ADR-0186 증보 v5 U-b-3: the unasked-card switch is a writable boolean — a literal `true` or
    /// `false`, never a string or a number the door would have to read as *off* — and `null` takes
    /// the key out (absent = on).
    #[test]
    fn agent_initiative_is_a_writable_boolean_switch() {
        for on_or_off in [true, false] {
            let merged =
                merge_workspace_settings(&json!({}), &json!({"agent_initiative": on_or_off}))
                    .expect("a boolean is a switch");
            assert_eq!(merged["agent_initiative"], json!(on_or_off));
        }
        for not_a_switch in [
            json!("false"),
            json!("true"),
            json!(0),
            json!(1),
            json!([]),
            json!({}),
        ] {
            assert_eq!(
                merge_workspace_settings(&json!({}), &json!({"agent_initiative": not_a_switch})),
                Err(WorkspaceSettingsInvalid::AgentInitiativeShape),
                "{not_a_switch} is not a switch"
            );
        }
        let cleared = merge_workspace_settings(
            &json!({"agent_initiative": false, "role_labels": {"owner": "대표"}}),
            &json!({"agent_initiative": null}),
        )
        .unwrap();
        assert!(
            cleared.get("agent_initiative").is_none(),
            "null = back to on"
        );
        assert_eq!(cleared["role_labels"], json!({"owner": "대표"}));
    }

    /// ADR-0201 증보 v3 B3 (#4964): `team_ai_roles` is a writable object of booleans over the six
    /// switchable bundles. `chat_read`, an unknown bundle, a non-boolean and a non-object are 400.
    #[test]
    fn team_ai_roles_takes_only_booleans_for_the_six_switchable_bundles() {
        assert!(ALLOWED_SETTINGS_KEYS.contains(&"team_ai_roles"));
        for bundle in TEAM_AI_ROLES_KEYS {
            for on in [true, false] {
                let merged =
                    merge_workspace_settings(&json!({}), &json!({"team_ai_roles": {bundle: on}}))
                        .unwrap_or_else(|error| panic!("{bundle}: {error}"));
                assert_eq!(merged["team_ai_roles"], json!({bundle: on}));
            }
        }
        for (patch, expected) in [
            (
                json!({"team_ai_roles": {"chat_read": false}}),
                WorkspaceSettingsInvalid::TeamAiRolesUnknownBundle("chat_read".into()),
            ),
            (
                json!({"team_ai_roles": {"chat_read": true}}),
                WorkspaceSettingsInvalid::TeamAiRolesUnknownBundle("chat_read".into()),
            ),
            (
                json!({"team_ai_roles": {"filez": true}}),
                WorkspaceSettingsInvalid::TeamAiRolesUnknownBundle("filez".into()),
            ),
            (
                json!({"team_ai_roles": {"files": "off"}}),
                WorkspaceSettingsInvalid::TeamAiRolesShape,
            ),
            (
                json!({"team_ai_roles": {"files": 0}}),
                WorkspaceSettingsInvalid::TeamAiRolesShape,
            ),
            (
                json!({"team_ai_roles": ["files"]}),
                WorkspaceSettingsInvalid::TeamAiRolesShape,
            ),
            (
                json!({"team_ai_roles": false}),
                WorkspaceSettingsInvalid::TeamAiRolesShape,
            ),
        ] {
            assert_eq!(
                merge_workspace_settings(&json!({}), &patch),
                Err(expected),
                "{patch}"
            );
        }
    }

    /// A patch that names one switch moves that switch and no other: the object is merged a level
    /// down, `null` drops a field (back to on), and `null` for the key drops the whole object.
    #[test]
    fn a_team_ai_roles_patch_moves_only_the_switches_it_names() {
        let existing = json!({
            "role_labels": {"owner": "대표"},
            "team_ai_roles": {"files": false, "invite_access": false}
        });
        let merged =
            merge_workspace_settings(&existing, &json!({"team_ai_roles": {"memory": false}}))
                .unwrap();
        assert_eq!(
            merged["team_ai_roles"],
            json!({"files": false, "invite_access": false, "memory": false}),
            "the switches the patch did not name stay as they were"
        );
        assert_eq!(merged["role_labels"], json!({"owner": "대표"}));

        let back_on = merge_workspace_settings(
            &merged,
            &json!({"team_ai_roles": {"files": true, "invite_access": null}}),
        )
        .unwrap();
        assert_eq!(
            back_on["team_ai_roles"],
            json!({"files": true, "memory": false}),
            "`true` replaces, `null` drops the field"
        );

        let cleared = merge_workspace_settings(&back_on, &json!({"team_ai_roles": null})).unwrap();
        assert!(cleared.get("team_ai_roles").is_none());
        assert_eq!(cleared["role_labels"], json!({"owner": "대표"}));

        // A stored value that is not an object is replaced, not merged into.
        let repaired = merge_workspace_settings(
            &json!({"team_ai_roles": "everything"}),
            &json!({"team_ai_roles": {"code": false}}),
        )
        .unwrap();
        assert_eq!(repaired["team_ai_roles"], json!({"code": false}));
    }

    /// ADR-0181 D8 / #1960: `welcome_prompt` is a writable settings key.
    #[test]
    fn welcome_prompt_is_an_allowed_key() {
        let copy = "무엇을 만들고 계세요? 하나 가져오시면 같이 시작해요";
        let merged = merge_workspace_settings(&json!({}), &json!({"welcome_prompt": copy}));
        assert!(merged.is_ok(), "{merged:?}");
        assert_eq!(merged.unwrap()["welcome_prompt"], json!(copy));
    }

    /// Proof ⑦: 2001 characters is 400, and it is a prompt-length error — not
    /// an unknown-key refusal that would also happen to be 400.
    #[test]
    fn welcome_prompt_rejects_2001_characters() {
        let too_long = "가".repeat(2001);
        let err = merge_workspace_settings(&json!({}), &json!({"welcome_prompt": too_long}))
            .expect_err("2001 chars must refuse");
        let msg = err.to_string();
        assert!(
            !msg.starts_with("unknown settings key"),
            "must be a prompt-length error, not an unknown-key error: {msg}"
        );
        assert!(
            msg.contains("2000"),
            "error must name the 2000-character cap: {msg}"
        );
    }

    /// ADR-0181 D3 / #1960: `welcome_agent_member_id` is a writable uuid key.
    #[test]
    fn welcome_agent_member_id_accepts_a_uuid_string() {
        let id = "00000000-0000-0000-0000-000000000001";
        let merged = merge_workspace_settings(&json!({}), &json!({"welcome_agent_member_id": id}));
        assert!(merged.is_ok(), "{merged:?}");
        assert_eq!(merged.unwrap()["welcome_agent_member_id"], json!(id));
    }

    /// ADR-0201 증보 v3 B9-1 (#4944): `team_ai_limits` takes only the three fields, each a real
    /// limit. `0` and a negative are NOT limits (400), a count is a whole number, `monthlyUsd` is a
    /// number above zero, and an unknown field is refused by name.
    #[test]
    fn team_ai_limits_take_three_real_limits_and_nothing_else() {
        for bad in [
            json!({"team_ai_limits": {"dailyTokens": 0}}),
            json!({"team_ai_limits": {"dailyTokens": -5}}),
            json!({"team_ai_limits": {"dailyTokens": 1.5}}),
            json!({"team_ai_limits": {"dailyTokens": 1000.0}}),
            json!({"team_ai_limits": {"dailyTokens": "1000"}}),
            json!({"team_ai_limits": {"dailyTokens": true}}),
            json!({"team_ai_limits": {"dailyTokens": MAX_TEAM_AI_LIMIT_COUNT + 1}}),
            json!({"team_ai_limits": {"dailySearches": 0}}),
            json!({"team_ai_limits": {"dailySearches": -1}}),
            json!({"team_ai_limits": {"monthlyUsd": 0}}),
            json!({"team_ai_limits": {"monthlyUsd": 0.0}}),
            json!({"team_ai_limits": {"monthlyUsd": -0.5}}),
            json!({"team_ai_limits": {"monthlyUsd": "12"}}),
            json!({"team_ai_limits": {"monthlyUsd": 0.0000001}}),
            json!({"team_ai_limits": {"monthlyUsd": MAX_TEAM_AI_LIMIT_USD + 1.0}}),
            json!({"team_ai_limits": {"dailyToken": 5}}),
            json!({"team_ai_limits": {"daily_tokens": 5}}),
            json!({"team_ai_limits": {"weeklyTokens": 5}}),
            json!({"team_ai_limits": [5]}),
            json!({"team_ai_limits": 5}),
            json!({"team_ai_limits": true}),
        ] {
            let refused = merge_workspace_settings(&json!({}), &bad);
            assert!(
                matches!(
                    refused,
                    Err(WorkspaceSettingsInvalid::TeamAiLimitsShape
                        | WorkspaceSettingsInvalid::TeamAiLimitsUnknownField(_)
                        | WorkspaceSettingsInvalid::TeamAiLimitsCount(_)
                        | WorkspaceSettingsInvalid::TeamAiLimitsUsd)
                ),
                "{bad} must be a limits refusal: {refused:?}"
            );
        }
        assert!(matches!(
            merge_workspace_settings(&json!({}), &json!({"team_ai_limits": {"dailyToken": 5}})),
            Err(WorkspaceSettingsInvalid::TeamAiLimitsUnknownField(name)) if name == "dailyToken"
        ));
        let ok = merge_workspace_settings(
            &json!({}),
            &json!({"team_ai_limits": {"dailyTokens": 500000, "dailySearches": 1, "monthlyUsd": 12.5}}),
        )
        .unwrap();
        assert_eq!(
            ok["team_ai_limits"],
            json!({"dailyTokens": 500000, "dailySearches": 1, "monthlyUsd": 12.5})
        );
        assert!(
            merge_workspace_settings(&json!({}), &json!({"team_ai_limits": {"monthlyUsd": 3}}))
                .is_ok(),
            "a whole dollar amount is a number too"
        );
    }

    /// The limits merge **one level down**: a patch that names one limit never moves another (a
    /// whole-object replace would have lifted `monthlyUsd` the moment someone set `dailyTokens`),
    /// `null` drops a field, and an object left with no field is no limit — the key goes.
    #[test]
    fn team_ai_limits_merge_one_limit_at_a_time_and_empty_means_no_limit() {
        let first = merge_workspace_settings(
            &json!({"role_labels": {"owner": "대표"}}),
            &json!({"team_ai_limits": {"monthlyUsd": 20}}),
        )
        .unwrap();
        let second =
            merge_workspace_settings(&first, &json!({"team_ai_limits": {"dailyTokens": 100000}}))
                .unwrap();
        assert_eq!(
            second["team_ai_limits"],
            json!({"monthlyUsd": 20, "dailyTokens": 100000}),
            "naming dailyTokens must not drop monthlyUsd"
        );
        assert_eq!(second["role_labels"], json!({"owner": "대표"}));
        let replaced =
            merge_workspace_settings(&second, &json!({"team_ai_limits": {"dailyTokens": 7}}))
                .unwrap();
        assert_eq!(replaced["team_ai_limits"]["dailyTokens"], json!(7));
        let dropped =
            merge_workspace_settings(&replaced, &json!({"team_ai_limits": {"monthlyUsd": null}}))
                .unwrap();
        assert_eq!(dropped["team_ai_limits"], json!({"dailyTokens": 7}));
        let none_left =
            merge_workspace_settings(&dropped, &json!({"team_ai_limits": {"dailyTokens": null}}))
                .unwrap();
        assert!(
            none_left.get("team_ai_limits").is_none(),
            "no field left = no limit"
        );
        let whole_null =
            merge_workspace_settings(&second, &json!({"team_ai_limits": null})).unwrap();
        assert!(whole_null.get("team_ai_limits").is_none());
        let empty = merge_workspace_settings(&json!({}), &json!({"team_ai_limits": {}})).unwrap();
        assert!(empty.get("team_ai_limits").is_none(), "{{}} stores nothing");
        // Hand-edited leftovers are not carried into the next save.
        let cleaned = merge_workspace_settings(
            &json!({"team_ai_limits": {"dailyTokens": 5, "stray": 1}}),
            &json!({"team_ai_limits": {"dailySearches": 2}}),
        )
        .unwrap();
        assert_eq!(
            cleaned["team_ai_limits"],
            json!({"dailyTokens": 5, "dailySearches": 2})
        );
    }
}
