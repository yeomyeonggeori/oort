//! Agent identity + profile: how an agent becomes a first-class member (B5.2).
//!
//! Measured against Swift `AgentRoutes.createAgentIdentity` (:98-183) and
//! `AgentProfileRoutes` (:115-367). This is the surface the packet calls
//! "에이전트 초대": in momo there is no bot to install, so inviting an agent is
//! creating a `member` with `kind='agent'` (invariant #5) and then adding it to
//! channels through the ordinary membership route.
//!
//! ## Three boundaries this module keeps
//!
//! 1. **Creation stops at the workspace identity boundary.** No channel
//!    membership and no credential are issued here — Swift's own header says so,
//!    and both are separate, explicit decisions. That is also why creating an
//!    agent does not make it mentionable *yet*: it has to be added to a channel
//!    first, which is exactly the state
//!    [`crate::mention::MentionCandidate::is_channel_member`] reports on.
//! 2. **No credential ever enters a stored field.** [`reject_credential_shaped_fields`]
//!    walks `config` / `profile.triggers` and refuses anything credential-shaped
//!    (ADR-0004: provider credentials do not flow into momo rows).
//! 3. **The `audit_log` row is the caller's**, written through `momo_db::audit`
//!    in the same transaction — the same split `routes::agent_runs` already uses.
//!
//! The `workspace_ban` predicate is deliberately **not** re-implemented here:
//! `momo_settings::is_handle_banned_in_tx` owns that table, and a second copy
//! would be a second answer to "may this handle exist".

use momo_db::DbError;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::effort::{known_level, supports, MAX_EFFORT_LENGTH};

/// Fragments that make a JSON key credential-shaped — Swift
/// `AgentCredentialFieldPolicy.forbiddenFragments` (:5-9), verbatim.
const FORBIDDEN_KEY_FRAGMENTS: [&str; 13] = [
    "credential",
    "accesstoken",
    "refreshtoken",
    "oauthtoken",
    "authorization",
    "clientsecret",
    "privatekey",
    "password",
    "bearertoken",
    "apikey",
    "codexaccess",
    "codexrefresh",
    "openaioauth",
];

pub const MODEL_MAX_CHARS: usize = 200;
pub const SYSTEM_PROMPT_MAX_BYTES: usize = 32_768;
pub const CONFIG_MAX_BYTES: usize = 65_536;
pub const INSTRUCTIONS_MAX_BYTES: usize = 8_192;
pub const TRIGGERS_MAX_BYTES: usize = 8_192;
pub const ENABLED_TOOLS_MAX: usize = 128;
pub const ENABLED_TOOL_NAME_MAX_CHARS: usize = 200;

/// Every way a create/profile body can be malformed, with Swift's wording so a
/// client that already renders the Swift server's errors needs no second
/// vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentSpecInvalid {
    #[error("model must contain 1...200 characters")]
    Model,
    #[error("systemPrompt must be at most 32768 bytes")]
    SystemPrompt,
    #[error("config must be at most 65536 bytes")]
    ConfigTooLarge,
    #[error("config must be a JSON object")]
    ConfigShape,
    #[error("credential-shaped field is forbidden at {0}")]
    CredentialShaped(String),
    #[error("instructions must be at most 8192 bytes")]
    Instructions,
    #[error("modelPref must contain 1...200 characters")]
    ModelPref,
    #[error("effortPref must be one of low, medium, high, xhigh, max")]
    EffortPref,
    #[error("effortPref '{level}' is not supported by modelPref '{model}'")]
    EffortPrefUnsupported { level: String, model: String },
    #[error("enabledTools must contain at most 128 entries")]
    EnabledToolsCount,
    #[error("enabledTools entries must be unique non-empty names")]
    EnabledToolsEntries,
    #[error("triggers must contain mention=true and only optional schedule")]
    Triggers,
    #[error("triggers must be at most 8192 bytes")]
    TriggersTooLarge,
    #[error("modelPref is not in workspace.settings.allowed_agent_models")]
    ModelPrefNotAllowed,
}

/// Refuse any object key whose normalized spelling contains a credential
/// fragment, at any depth — Swift `rejectCredentialShapedFields` (:11-34).
///
/// Normalization strips every non-alphanumeric character and lowercases, so
/// `API_KEY`, `api-key` and `apiKey` are one key to this check. Without that,
/// the policy would be a spelling test rather than a policy.
pub fn reject_credential_shaped_fields(value: &Value, path: &str) -> Result<(), AgentSpecInvalid> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let normalized: String = key
                    .to_lowercase()
                    .chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect();
                if FORBIDDEN_KEY_FRAGMENTS
                    .iter()
                    .any(|fragment| normalized.contains(fragment))
                {
                    return Err(AgentSpecInvalid::CredentialShaped(format!("{path}.{key}")));
                }
                reject_credential_shaped_fields(child, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                reject_credential_shaped_fields(child, &format!("{path}[{index}]"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Swift `AgentRoutes.normalizedModel` (:88-94).
pub fn normalized_model(raw: &str) -> Result<String, AgentSpecInvalid> {
    let value = raw.trim();
    let length = value.chars().count();
    if length == 0 || length > MODEL_MAX_CHARS {
        return Err(AgentSpecInvalid::Model);
    }
    Ok(value.to_string())
}

/// Swift `AgentRoutes.normalizedSystemPrompt` (:185-193). A blank prompt is
/// `None`, not `Some("")` — an empty section in the effective prompt would be
/// noise the model has to read.
pub fn normalized_system_prompt(raw: Option<&str>) -> Result<Option<String>, AgentSpecInvalid> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > SYSTEM_PROMPT_MAX_BYTES {
        return Err(AgentSpecInvalid::SystemPrompt);
    }
    Ok(Some(value.to_string()))
}

/// Swift `AgentRoutes.validatedConfig` (:249-257): an object, credential-free,
/// under the byte ceiling.
pub fn validated_config(raw: Option<&Value>) -> Result<Value, AgentSpecInvalid> {
    let config = match raw {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(value) => value.clone(),
    };
    if !config.is_object() {
        return Err(AgentSpecInvalid::ConfigShape);
    }
    reject_credential_shaped_fields(&config, "config")?;
    if serde_json::to_string(&config)
        .map(|text| text.len())
        .unwrap_or(usize::MAX)
        > CONFIG_MAX_BYTES
    {
        return Err(AgentSpecInvalid::ConfigTooLarge);
    }
    Ok(config)
}

/// A validated `agent_profile` body — Swift `ValidatedAgentProfile` (:553-560).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfileSpec {
    pub instructions: String,
    pub model_pref: Option<String>,
    pub effort_pref: Option<String>,
    pub enabled_tools: Vec<String>,
    pub triggers: Value,
}

/// Swift `AgentProfileValidation.validate` (:479-521).
///
/// `triggers` defaults to `{"mention": true}` and `mention` may not be turned
/// off: v0 has exactly one executor, and a profile that claimed a `schedule`
/// trigger without one would be a promise the server cannot keep (the column
/// comment in migration 036 says so).
pub fn validate_agent_profile(
    instructions: &str,
    model_pref: Option<&str>,
    effort_pref: Option<&str>,
    enabled_tools: &[String],
    triggers: Option<&Value>,
) -> Result<AgentProfileSpec, AgentSpecInvalid> {
    if instructions.len() > INSTRUCTIONS_MAX_BYTES {
        return Err(AgentSpecInvalid::Instructions);
    }
    let model_pref = match model_pref.map(str::trim) {
        None => None,
        Some(value) => {
            let length = value.chars().count();
            if length == 0 || length > MODEL_MAX_CHARS {
                return Err(AgentSpecInvalid::ModelPref);
            }
            Some(value.to_string())
        }
    };
    let effort_pref = normalized_effort_pref(effort_pref, model_pref.as_deref())?;

    if enabled_tools.len() > ENABLED_TOOLS_MAX {
        return Err(AgentSpecInvalid::EnabledToolsCount);
    }
    let tools: Vec<String> = enabled_tools
        .iter()
        .map(|tool| tool.trim().to_string())
        .collect();
    let all_shaped = tools
        .iter()
        .all(|tool| !tool.is_empty() && tool.chars().count() <= ENABLED_TOOL_NAME_MAX_CHARS);
    let mut unique = tools.clone();
    unique.sort();
    unique.dedup();
    if !all_shaped || unique.len() != tools.len() {
        return Err(AgentSpecInvalid::EnabledToolsEntries);
    }

    let triggers = triggers
        .cloned()
        .unwrap_or_else(|| json!({"mention": true}));
    let object = triggers.as_object().ok_or(AgentSpecInvalid::Triggers)?;
    if object.get("mention") != Some(&Value::Bool(true))
        || object
            .keys()
            .any(|key| key != "mention" && key != "schedule")
    {
        return Err(AgentSpecInvalid::Triggers);
    }
    reject_credential_shaped_fields(&triggers, "profile.triggers")?;
    if serde_json::to_string(&triggers)
        .map(|text| text.len())
        .unwrap_or(usize::MAX)
        > TRIGGERS_MAX_BYTES
    {
        return Err(AgentSpecInvalid::TriggersTooLarge);
    }

    Ok(AgentProfileSpec {
        instructions: instructions.to_string(),
        model_pref,
        effort_pref,
        enabled_tools: tools,
        triggers,
    })
}

/// Swift `AgentProfileValidation.normalizedEffortPref` (:540-550).
///
/// The asymmetry is the decision (ADR-0134 D3): writing a preference is an
/// explicit act, so an unusable one is a **400 here** — while at *run* time the
/// same stored value is silently ignored, because by then the resolved model may
/// have changed under a profile nobody re-saved.
fn normalized_effort_pref(
    raw: Option<&str>,
    model_pref: Option<&str>,
) -> Result<Option<String>, AgentSpecInvalid> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.len() > MAX_EFFORT_LENGTH {
        return Err(AgentSpecInvalid::EffortPref);
    }
    let level = known_level(Some(raw)).ok_or(AgentSpecInvalid::EffortPref)?;
    if let Some(model) = model_pref {
        if !supports(model, level) {
            return Err(AgentSpecInvalid::EffortPrefUnsupported {
                level: level.to_string(),
                model: model.to_string(),
            });
        }
    }
    Ok(Some(level.to_string()))
}

/// The workspace-identity half of an agent — everything
/// [`create_agent_identity_in_tx`] writes.
#[derive(Debug, Clone)]
pub struct NewAgentMember {
    pub display_name: String,
    pub handle: String,
    pub model: String,
    /// Already through `momo_settings::validated_base_url`.
    pub base_url: String,
    pub system_prompt: Option<String>,
    pub config: Value,
    /// The human who operates it. Verified to be an active human of this
    /// workspace **inside** the same statement's transaction.
    pub owner_human_id: Uuid,
}

/// The created agent, as the create response projects it (Swift `AgentMemberDTO`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMember {
    pub id: Uuid,
    pub handle: String,
    pub display_name: String,
}

/// Why a create did not happen — Swift `AgentCreationResult` (:270-275) minus
/// `forbidden`, which is an authorization decision the route makes before this
/// is called.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCreation {
    Created(AgentMember),
    DuplicateHandle,
    InvalidOwner,
}

/// Create the agent's `member`, `agent` and `workspace_membership` rows.
///
/// The owner check is a query rather than an assumption: `agent.owner_human_id`
/// is who may edit the profile without being a workspace admin
/// (`AgentProfileRoutes.requireEditor`), so accepting an unverified id would
/// hand profile-edit rights to any member id a caller can guess.
///
/// `ON CONFLICT (workspace_id, handle) DO NOTHING` is Swift's, and the empty
/// result **is** the 409: a pre-read would report a free handle to two
/// concurrent creates.
pub async fn create_agent_identity_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    input: &NewAgentMember,
) -> Result<AgentCreation, DbError> {
    let owner: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM member \
          WHERE id = $1 AND workspace_id = $2 AND kind = 'human' \
            AND status = 'active' AND deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(input.owner_human_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    if owner.is_none() {
        return Ok(AgentCreation::InvalidOwner);
    }

    let agent_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO member (workspace_id, kind, status, display_name, handle) \
         VALUES ($1, 'agent', 'active', $2, $3) \
         ON CONFLICT (workspace_id, handle) DO NOTHING \
         RETURNING id",
    )
    .bind(workspace_id)
    .bind(&input.display_name)
    .bind(&input.handle)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(agent_id) = agent_id else {
        return Ok(AgentCreation::DuplicateHandle);
    };

    sqlx::query(
        "INSERT INTO agent \
           (member_id, workspace_id, model, base_url, system_prompt, \
            tool_schema, config, owner_human_id) \
         VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7)",
    )
    .bind(agent_id)
    .bind(workspace_id)
    .bind(&input.model)
    .bind(&input.base_url)
    .bind(input.system_prompt.as_deref())
    .bind(&input.config)
    .bind(input.owner_human_id)
    .execute(&mut *conn)
    .await?;

    // Invariant #5 in one row: an agent holds an ordinary workspace membership,
    // which is what puts it in the roster beside the humans instead of in a
    // separate "integrations" list.
    sqlx::query(
        "INSERT INTO workspace_membership (workspace_id, member_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(workspace_id)
    .bind(agent_id)
    .execute(&mut *conn)
    .await?;

    Ok(AgentCreation::Created(AgentMember {
        id: agent_id,
        handle: input.handle.clone(),
        display_name: input.display_name.clone(),
    }))
}

/// One `agent_profile` row as the read surface projects it (Swift
/// `AgentProfileDTO`, :562-575).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentProfile {
    pub agent_member_id: Uuid,
    pub workspace_id: Uuid,
    pub instructions: String,
    pub model_pref: Option<String>,
    pub effort_pref: Option<String>,
    pub enabled_tools: Vec<String>,
    pub triggers: Value,
    pub paused: bool,
    pub version: i32,
    pub updated_by: Uuid,
    pub updated_at_ms: i64,
}

fn decode_profile(
    row: &sqlx::postgres::PgRow,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<AgentProfile, sqlx::Error> {
    let enabled_tools: Value = row.try_get("enabled_tools")?;
    let tools = enabled_tools
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let updated_at: chrono::DateTime<chrono::Utc> = row.try_get("updated_at")?;
    Ok(AgentProfile {
        agent_member_id,
        workspace_id,
        instructions: row.try_get("instructions")?,
        model_pref: row.try_get("model_pref")?,
        effort_pref: row.try_get("effort_pref")?,
        enabled_tools: tools,
        triggers: row.try_get("triggers")?,
        paused: row.try_get("paused")?,
        version: row.try_get("version")?,
        updated_by: row.try_get("updated_by")?,
        updated_at_ms: updated_at.timestamp_millis(),
    })
}

const PROFILE_COLS: &str = "instructions, model_pref, effort_pref, enabled_tools, triggers, \
     paused, version, updated_by, updated_at";

/// The agent's own `agent.model` + its workspace's `settings` — the two inputs
/// the ADR-0131 D2 allow-list needs, read inside the transaction that is about
/// to write the profile.
///
/// `None` when the target is not an active agent of this workspace, which the
/// caller answers with a 404 rather than writing a profile for a member that
/// does not exist.
pub async fn load_agent_model_policy_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<(String, Value)>, DbError> {
    let row = sqlx::query(
        "SELECT a.model, w.settings \
           FROM agent a \
           JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id \
           JOIN workspace w ON w.id = a.workspace_id \
          WHERE a.workspace_id = $1 AND a.member_id = $2 \
            AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some((
        row.try_get("model").map_err(DbError::from)?,
        row.try_get("settings").map_err(DbError::from)?,
    )))
}

/// `agent.owner_human_id` for an **active** agent — the input to
/// `AgentProfileRoutes.requireEditor` (:369-406).
///
/// `Ok(None)` means "no such active agent", which is a 404; `Ok(Some(None))`
/// means the agent has no owner, so only a workspace admin may edit it.
#[allow(clippy::type_complexity)]
pub async fn agent_owner_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<Option<Uuid>>, DbError> {
    let row = sqlx::query(
        "SELECT a.owner_human_id \
           FROM agent a \
           JOIN member m ON m.workspace_id = a.workspace_id AND m.id = a.member_id \
          WHERE a.workspace_id = $1 AND a.member_id = $2 \
            AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some(row) => Some(row.try_get("owner_human_id").map_err(DbError::from)?),
        None => None,
    })
}

/// Insert or update the agent's profile — Swift `AgentProfileRoutes.upsert`
/// (:192-268), minus its audit row (the caller's).
///
/// `version` increments on every write, which is what a hub UI shows as "edited
/// N times" and what `load_mention_candidates_in_tx` reads to tell "no profile"
/// from "a profile with empty instructions".
pub async fn upsert_agent_profile_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    actor_member_id: Uuid,
    profile: &AgentProfileSpec,
) -> Result<Option<AgentProfile>, DbError> {
    let sql = format!(
        "INSERT INTO agent_profile \
           (agent_member_id, workspace_id, instructions, model_pref, effort_pref, \
            enabled_tools, triggers, version, updated_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, now()) \
         ON CONFLICT (agent_member_id) DO UPDATE \
            SET instructions = EXCLUDED.instructions, \
                model_pref = EXCLUDED.model_pref, \
                effort_pref = EXCLUDED.effort_pref, \
                enabled_tools = EXCLUDED.enabled_tools, \
                triggers = EXCLUDED.triggers, \
                version = agent_profile.version + 1, \
                updated_by = EXCLUDED.updated_by, \
                updated_at = now() \
            WHERE agent_profile.workspace_id = EXCLUDED.workspace_id \
         RETURNING {PROFILE_COLS}"
    );
    let tools = Value::Array(
        profile
            .enabled_tools
            .iter()
            .map(|tool| Value::String(tool.clone()))
            .collect(),
    );
    let row = sqlx::query(&sql)
        .bind(agent_member_id)
        .bind(workspace_id)
        .bind(&profile.instructions)
        .bind(profile.model_pref.as_deref())
        .bind(profile.effort_pref.as_deref())
        .bind(&tools)
        .bind(&profile.triggers)
        .bind(actor_member_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(|row| decode_profile(row, workspace_id, agent_member_id))
        .transpose()
        .map_err(DbError::from)
}

/// Flip `agent_profile.paused` — Swift `AgentProfileRoutes.setPaused` (:270-325),
/// minus its audit row (the caller's).
///
/// Three properties the statement's shape carries, none of them incidental:
///
/// 1. **An agent nobody configured can still be paused.** The `INSERT` half
///    creates the profile row at its column defaults, so pausing does not require
///    an operator to first write instructions they do not have. Swift does the
///    same, and `load_mention_candidates_in_tx` reads `COALESCE(ap.paused, false)`
///    precisely because the row may not have existed a moment ago.
/// 2. **A no-op write does not bump `version`.** The `CASE … IS DISTINCT FROM`
///    arms leave `version`/`updated_by`/`updated_at` alone when the flag already
///    held that value, so a hub UI polling pause state cannot inflate the edit
///    count of a profile nobody edited.
/// 3. **`Ok(None)` is a 404, never a silent cross-tenant write.** The
///    `WHERE agent_profile.workspace_id = EXCLUDED.workspace_id` guard on the
///    conflict arm means a row belonging to another workspace updates nothing and
///    returns nothing — RLS refuses it first, and this is the second lock.
pub async fn set_agent_paused_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    actor_member_id: Uuid,
    paused: bool,
) -> Result<Option<AgentProfile>, DbError> {
    let sql = format!(
        "INSERT INTO agent_profile \
           (agent_member_id, workspace_id, paused, version, updated_by, updated_at) \
         VALUES ($1, $2, $3, 1, $4, now()) \
         ON CONFLICT (agent_member_id) DO UPDATE \
            SET paused = EXCLUDED.paused, \
                version = CASE \
                  WHEN agent_profile.paused IS DISTINCT FROM EXCLUDED.paused \
                  THEN agent_profile.version + 1 ELSE agent_profile.version END, \
                updated_by = CASE \
                  WHEN agent_profile.paused IS DISTINCT FROM EXCLUDED.paused \
                  THEN EXCLUDED.updated_by ELSE agent_profile.updated_by END, \
                updated_at = CASE \
                  WHEN agent_profile.paused IS DISTINCT FROM EXCLUDED.paused \
                  THEN now() ELSE agent_profile.updated_at END \
            WHERE agent_profile.workspace_id = EXCLUDED.workspace_id \
         RETURNING {PROFILE_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(agent_member_id)
        .bind(workspace_id)
        .bind(paused)
        .bind(actor_member_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(|row| decode_profile(row, workspace_id, agent_member_id))
        .transpose()
        .map_err(DbError::from)
}

/// Read one agent's profile — Swift `AgentProfileRoutes.load` (:327-346).
pub async fn load_agent_profile_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<AgentProfile>, DbError> {
    let sql = format!(
        "SELECT {PROFILE_COLS} FROM agent_profile \
          WHERE workspace_id = $1 AND agent_member_id = $2"
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(agent_member_id)
        .fetch_optional(&mut *conn)
        .await?;
    row.as_ref()
        .map(|row| decode_profile(row, workspace_id, agent_member_id))
        .transpose()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-0004: a provider credential must not be able to enter a stored agent
    /// field, whatever the caller spells it. The normalization is what makes this
    /// a policy rather than a spelling test.
    #[test]
    fn every_spelling_of_a_credential_key_is_refused() {
        for key in [
            "api_key",
            "apiKey",
            "API-KEY",
            "openai_api_key",
            "clientSecret",
            "Authorization",
            "refresh_token",
        ] {
            let config = json!({ key: "x" });
            assert!(
                reject_credential_shaped_fields(&config, "config").is_err(),
                "{key} must be refused"
            );
        }
        // Nested and inside arrays too — a policy that only checks the top level
        // is a policy anyone can step around with one more object.
        assert!(reject_credential_shaped_fields(&json!({"a": {"password": 1}}), "config").is_err());
        assert!(
            reject_credential_shaped_fields(&json!({"a": [{"privateKey": 1}]}), "config").is_err()
        );
        assert!(reject_credential_shaped_fields(&json!({"temperature": 0.2}), "config").is_ok());
    }

    #[test]
    fn the_error_names_the_offending_path() {
        let error = reject_credential_shaped_fields(&json!({"a": {"apiKey": 1}}), "config")
            .expect_err("refused");
        assert_eq!(
            error.to_string(),
            "credential-shaped field is forbidden at config.a.apiKey"
        );
    }

    #[test]
    fn a_model_must_be_present_and_bounded() {
        assert_eq!(normalized_model("  hermes-agent ").unwrap(), "hermes-agent");
        assert!(normalized_model("   ").is_err());
        assert!(normalized_model(&"x".repeat(MODEL_MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn a_blank_system_prompt_is_absent_rather_than_empty() {
        assert_eq!(normalized_system_prompt(None).unwrap(), None);
        assert_eq!(normalized_system_prompt(Some("   ")).unwrap(), None);
        assert_eq!(
            normalized_system_prompt(Some(" be terse "))
                .unwrap()
                .as_deref(),
            Some("be terse")
        );
        assert!(normalized_system_prompt(Some(&"x".repeat(SYSTEM_PROMPT_MAX_BYTES + 1))).is_err());
    }

    #[test]
    fn config_defaults_to_an_object_and_refuses_a_non_object() {
        assert_eq!(validated_config(None).unwrap(), json!({}));
        assert_eq!(validated_config(Some(&Value::Null)).unwrap(), json!({}));
        assert!(validated_config(Some(&json!([1, 2]))).is_err());
        assert_eq!(
            validated_config(Some(&json!({"max_output_tokens": 512}))).unwrap(),
            json!({"max_output_tokens": 512})
        );
    }

    /// v0 has exactly one trigger executor. A profile that turned `mention` off,
    /// or invented a third trigger, would be a promise no worker keeps.
    #[test]
    fn triggers_must_keep_mention_on_and_invent_nothing() {
        let ok = validate_agent_profile("", None, None, &[], None).expect("defaults");
        assert_eq!(ok.triggers, json!({"mention": true}));

        for bad in [
            json!({"mention": false}),
            json!({}),
            json!({"mention": true, "webhook": true}),
            json!("mention"),
        ] {
            assert!(
                validate_agent_profile("", None, None, &[], Some(&bad)).is_err(),
                "{bad} must be refused"
            );
        }
        assert!(validate_agent_profile(
            "",
            None,
            None,
            &[],
            Some(&json!({"mention": true, "schedule": {"cron": "0 9 * * *"}}))
        )
        .is_ok());
    }

    /// Writing a preference is explicit, so an unusable one is a visible 400 —
    /// the opposite of the run-time rule, and deliberately so (ADR-0134 D3).
    #[test]
    fn an_effort_pref_the_named_model_cannot_honour_is_a_400() {
        let error = validate_agent_profile("", Some("hermes-fast"), Some("max"), &[], None)
            .expect_err("unsupported");
        assert!(
            matches!(error, AgentSpecInvalid::EffortPrefUnsupported { .. }),
            "{error}"
        );
        assert!(validate_agent_profile("", None, Some("nope"), &[], None).is_err());
        // Without a modelPref only the canonical level set is checkable.
        let spec = validate_agent_profile("", None, Some("MAX"), &[], None).expect("known level");
        assert_eq!(spec.effort_pref.as_deref(), Some("max"));
    }

    #[test]
    fn enabled_tools_must_be_unique_non_empty_and_bounded() {
        assert!(
            validate_agent_profile("", None, None, &["read".into(), "read".into()], None).is_err()
        );
        assert!(validate_agent_profile("", None, None, &["  ".into()], None).is_err());
        let many: Vec<String> = (0..=ENABLED_TOOLS_MAX).map(|i| format!("t{i}")).collect();
        assert!(validate_agent_profile("", None, None, &many, None).is_err());
        let spec = validate_agent_profile("", None, None, &[" read ".into()], None).expect("valid");
        assert_eq!(spec.enabled_tools, vec!["read".to_string()]);
    }

    #[test]
    fn instructions_are_bounded_by_the_columns_own_check() {
        assert!(validate_agent_profile(
            &"x".repeat(INSTRUCTIONS_MAX_BYTES + 1),
            None,
            None,
            &[],
            None
        )
        .is_err());
    }
}
