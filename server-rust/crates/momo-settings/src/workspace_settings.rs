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
pub const ALLOWED_SETTINGS_KEYS: &[&str] = &["allowed_agent_models", "role_labels"];

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
        current.insert(key.clone(), value.clone());
    }
    Ok(Value::Object(current))
}

fn validate_settings_value(key: &str, value: &Value) -> Result<(), WorkspaceSettingsInvalid> {
    match key {
        "allowed_agent_models" => validate_allowed_agent_models(value),
        "role_labels" => validate_role_labels(value),
        _ => Err(WorkspaceSettingsInvalid::UnknownKey(key.to_string())),
    }
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
}
