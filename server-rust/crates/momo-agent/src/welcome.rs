//! Welcome kickoff — resolve the default-channel agent and build the job
//! (ADR-0181).
//!
//! The route layer composes this with `create_agent_run_in_tx` (the worker
//! does that, not join) and `emit_outbox`. This module owns **no INSERT**.

use momo_db::DbError;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::mention::{effective_system_prompt, max_output_tokens};
use crate::run::{RunTrigger, WelcomeKind};

/// ADR-0181 D8. Orchestrator reviews the copy.
pub const DEFAULT_WELCOME_PROMPT: &str = "무엇을 만들고 계세요? 하나 가져오시면 같이 시작해요";

/// ADR-0181 D5. Static agent-attributed copy when no provider is linked.
pub const PROVIDER_REQUIRED_BODY: &str = "설정 › AI 연결에서 연결하고 돌아오면 시작해요";

pub const WELCOME_JOB_CREATED_FROM: &str = "server.welcome.kickoff.v1";
pub const WELCOME_RUN_INPUT_SCHEMA: &str = "momo.agent_run.input.v0";
pub const WELCOME_AUDIT_QUEUED: &str = "agent.welcome.queued";
pub const WELCOME_AUDIT_PROVIDER_REQUIRED: &str = "agent.welcome.provider_required";
pub const WELCOME_AUDIT_SCHEMA: &str = "momo.agent.welcome.v1";

/// The agent + channel + prompt a first join should kick off, or `None` when
/// the workspace has no one who can speak (D3: silent, no system line).
#[derive(Debug, Clone)]
pub struct WelcomeTarget {
    pub agent_member_id: Uuid,
    pub channel_id: Uuid,
    pub prompt: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub tool_schema: Value,
    pub config: Value,
    pub max_run_steps: i32,
    pub enabled_tools: Vec<String>,
}

fn upper(id: Uuid) -> String {
    id.to_string().to_uppercase()
}

fn stored_prompt(settings: &Value) -> String {
    settings
        .get("welcome_prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_WELCOME_PROMPT)
        .to_string()
}

fn stored_welcome_agent(settings: &Value) -> Option<Uuid> {
    settings
        .get("welcome_agent_member_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
}

/// Default channel `#general`, plus the welcome agent (settings override, else
/// first active native agent in that channel).
pub async fn resolve_welcome_target_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<WelcomeTarget>, DbError> {
    let settings: Value = sqlx::query_scalar("SELECT settings FROM workspace WHERE id = $1")
        .bind(workspace_id)
        .fetch_optional(&mut *conn)
        .await?
        .unwrap_or_else(|| json!({}));
    let channel_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM channel \
          WHERE workspace_id = $1 \
            AND kind = 'public' \
            AND name = 'general' \
            AND archived_at IS NULL \
          ORDER BY created_at ASC, id ASC \
          LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(channel_id) = channel_id else {
        return Ok(None);
    };
    let specified = stored_welcome_agent(&settings);
    let agent = load_welcome_agent_in_tx(conn, workspace_id, channel_id, specified).await?;
    let Some(agent) = agent else {
        return Ok(None);
    };
    Ok(Some(WelcomeTarget {
        agent_member_id: agent.member_id,
        channel_id,
        prompt: stored_prompt(&settings),
        model: agent.model,
        system_prompt: agent.system_prompt,
        tool_schema: agent.tool_schema,
        config: agent.config,
        max_run_steps: agent.max_run_steps,
        enabled_tools: agent.enabled_tools,
    }))
}

struct WelcomeAgent {
    member_id: Uuid,
    model: String,
    system_prompt: Option<String>,
    tool_schema: Value,
    config: Value,
    max_run_steps: i32,
    enabled_tools: Vec<String>,
}

async fn load_welcome_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    specified: Option<Uuid>,
) -> Result<Option<WelcomeAgent>, DbError> {
    let row = sqlx::query(
        "SELECT m.id, a.model, a.system_prompt, a.max_run_steps, a.tool_schema, a.config, \
                ap.instructions, ap.enabled_tools, ap.version AS profile_version, \
                EXISTS (SELECT 1 FROM agent_card_registration acr \
                         WHERE acr.workspace_id = m.workspace_id \
                           AND acr.agent_member_id = m.id \
                           AND acr.status = 'confirmed') AS is_external_runtime \
           FROM member m \
           JOIN agent a ON a.member_id = m.id AND a.workspace_id = m.workspace_id \
           LEFT JOIN agent_profile ap \
             ON ap.workspace_id = m.workspace_id AND ap.agent_member_id = m.id \
          WHERE m.workspace_id = $1 \
            AND m.kind = 'agent' \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
            AND COALESCE(ap.paused, false) = false \
            AND NOT EXISTS ( \
                  SELECT 1 FROM hosted_agent_connection hc \
                   WHERE hc.workspace_id = m.workspace_id AND hc.agent_member_id = m.id \
                ) \
            AND EXISTS ( \
                  SELECT 1 FROM membership ms \
                   WHERE ms.channel_id = $2 \
                     AND ms.member_id = m.id \
                     AND ms.left_at IS NULL \
                ) \
            AND ($3::uuid IS NULL OR m.id = $3) \
          ORDER BY m.created_at ASC, m.id ASC \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(specified)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let profile_version: Option<i32> = row.try_get("profile_version")?;
    let instructions: Option<String> = row.try_get("instructions")?;
    let enabled_tools: Option<Value> = row.try_get("enabled_tools")?;
    let enabled_tools: Vec<String> = enabled_tools
        .as_ref()
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let base_system_prompt: Option<String> = row.try_get("system_prompt")?;
    let is_external_runtime: bool = row.try_get("is_external_runtime")?;
    let profile_instructions = profile_version.map(|_| instructions.unwrap_or_default());
    Ok(Some(WelcomeAgent {
        member_id: row.try_get("id")?,
        model: row.try_get("model")?,
        system_prompt: effective_system_prompt(
            base_system_prompt.as_deref(),
            profile_instructions.as_deref(),
            !is_external_runtime,
        ),
        tool_schema: row.try_get("tool_schema")?,
        config: row.try_get("config")?,
        max_run_steps: row.try_get("max_run_steps")?,
        enabled_tools,
    }))
}

pub fn welcome_run_input(
    workspace_id: Uuid,
    member_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    kind: WelcomeKind,
    prompt: &str,
    idempotency_key: &str,
) -> Value {
    json!({
        "schema": WELCOME_RUN_INPUT_SCHEMA,
        "surface": "welcome",
        "welcome_kind": kind.as_key(),
        "prompt": prompt,
        "idempotency_key": idempotency_key,
        "author_member_id": upper(member_id),
        "agent_member_id": upper(agent_member_id),
        "channel_id": upper(channel_id),
        "workspace_id": upper(workspace_id),
        "depth": 0,
    })
}

pub fn welcome_job_payload(
    workspace_id: Uuid,
    member_id: Uuid,
    target: &WelcomeTarget,
    kind: WelcomeKind,
    delivery: &str,
    created_at_ms: i64,
) -> Value {
    let trigger = RunTrigger::Welcome {
        workspace_id,
        member_id,
        agent_member_id: target.agent_member_id,
        channel_id: target.channel_id,
        kind,
    };
    let mut payload = Map::new();
    payload.insert("workspace_id".into(), json!(upper(workspace_id)));
    payload.insert("channel_id".into(), json!(upper(target.channel_id)));
    payload.insert(
        "agent_member_id".into(),
        json!(upper(target.agent_member_id)),
    );
    payload.insert("author_member_id".into(), json!(upper(member_id)));
    payload.insert("model".into(), json!(target.model));
    payload.insert("prompt".into(), json!(target.prompt));
    payload.insert("recent_messages".into(), json!([]));
    payload.insert("tools".into(), target.tool_schema.clone());
    if !target.enabled_tools.is_empty() {
        payload.insert("enabled_tools".into(), json!(target.enabled_tools.clone()));
    }
    payload.insert(
        "max_output_tokens".into(),
        json!(max_output_tokens(&target.config)),
    );
    payload.insert("max_steps".into(), json!(target.max_run_steps));
    payload.insert("step_count".into(), json!(0));
    payload.insert("depth".into(), json!(0));
    payload.insert("consecutive_auto".into(), json!(0));
    payload.insert("delivery".into(), json!(delivery));
    payload.insert("created_from".into(), json!(WELCOME_JOB_CREATED_FROM));
    payload.insert("welcome_kind".into(), json!(kind.as_key()));
    payload.insert("created_at_ms".into(), json!(created_at_ms));
    payload.insert("idempotency_key".into(), json!(trigger.idempotency_key()));
    if let Some(system_prompt) = target
        .system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload.insert("system_prompt".into(), json!(system_prompt));
    }
    Value::Object(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_copy_is_a_plain_korean_sentence() {
        assert!(DEFAULT_WELCOME_PROMPT.contains("무엇을 만들고 계세요"));
        assert!(!DEFAULT_WELCOME_PROMPT.contains('!'));
        assert!(PROVIDER_REQUIRED_BODY.contains("AI 연결"));
    }

    #[test]
    fn stored_prompt_falls_back_to_the_canonical_copy() {
        assert_eq!(stored_prompt(&json!({})), DEFAULT_WELCOME_PROMPT);
        assert_eq!(
            stored_prompt(&json!({"welcome_prompt": "   "})),
            DEFAULT_WELCOME_PROMPT
        );
        assert_eq!(
            stored_prompt(&json!({"welcome_prompt": "직접 편집한 프롬프트"})),
            "직접 편집한 프롬프트"
        );
    }
}
