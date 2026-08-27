//! `workspace.settings` bag — operator GET/PATCH domain (#1800).
//!
//! The column already exists (`schema_v0.sql`). This module is the only writer
//! that goes through REST: top-level RFC 7396 merge, a closed allowlist, and
//! hard size caps. Semantics of a stored key stay with the helper that already
//! reads it (`momo_agent::allowed_agent_models`). `role_labels` is reserved for
//! AC-4 and is rejected here.

use momo_db::DbError;
use serde_json::{Map, Value};
use sqlx::PgConnection;
use uuid::Uuid;

/// The only top-level key this surface accepts today.
pub const ALLOWED_SETTINGS_KEYS: &[&str] = &["allowed_agent_models"];

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
    fn unknown_and_reserved_keys_are_refused() {
        assert!(matches!(
            merge_workspace_settings(&json!({}), &json!({"role_labels": {}})),
            Err(WorkspaceSettingsInvalid::UnknownKey(key)) if key == "role_labels"
        ));
        assert!(matches!(
            merge_workspace_settings(&json!({}), &json!({"allowedAgentModels": ["x"]})),
            Err(WorkspaceSettingsInvalid::UnknownKey(_))
        ));
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
}
