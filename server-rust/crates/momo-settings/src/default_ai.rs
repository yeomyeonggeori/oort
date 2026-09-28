//! 「기본 AI」 운영자 행 — the instance-global default AI for the rows the team
//! sees (#3009, ADR-0147 증보 2026-09-28 · ADR-0190 증보 2026-09-28).
//!
//! 설정 › AI 연결 › 「기본 AI」 is a table of features (brief §4.2). Its personal
//! rows (앱 명령, 로컬 터미널, 원격 작업) are stored on the device and never reach
//! this server (brief §4.5 invariant 4). Its **team** rows are server settings
//! only an instance operator may change:
//!
//! | role | what it picks | stored here |
//! |---|---|---|
//! | `team_agent` | the team link + model a team agent falls back to | yes |
//! | `summary` | the team link + model for channel summary / welcome opener | yes |
//! | `guardrail` | the decision model (Jev) | **no** — `off` until the 판정기 ADR is Accepted (AI 계정 Q6) |
//!
//! ## What a row may hold
//!
//! A **link reference** and a **model id** — nothing else. The reference is the
//! cascade position (0 = the `provider_link` singleton or its env fallback, 1
//! and up = a `provider_link_chain` hop) plus the redacted endpoint label that
//! position had when the operator chose it. `PUT …/chain` deletes and re-inserts
//! every hop (`chain::replace_chain`), so a position alone is not a stable id:
//! the label snapshot is what lets a read say *"this position now points at a
//! different provider"* (`linkResolved: false`) instead of silently following it.
//!
//! The only credential source a row can name is [`TEAM_LINK_SOURCE`]. A personal
//! subscription profile (a `CLAUDE_CONFIG_DIR` / `CODEX_HOME` on someone's Mac)
//! is refused by the route, and the table's CHECK refuses it again, so a team
//! agent can never be pointed at a personal credential (brief §4.5 invariant 2).
//!
//! ## Model ids from a provider
//!
//! [`sanitized_model_id`] is the single spelling of "a model id this server will
//! store or repeat". The live probe uses it on `GET {base}/models` bodies, and
//! the route uses it on operator input, so the two can never disagree about
//! what an id looks like.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// The one credential source a team row may name.
pub const TEAM_LINK_SOURCE: &str = "team_link";

/// Longest model id kept, in bytes. The same bound `allowed_agent_models`
/// entries carry (`workspace_settings::MAX_ALLOWED_AGENT_MODEL_BYTES`), so an id
/// chosen here always fits the agent model allow-list.
pub const MAX_MODEL_ID_BYTES: usize = 64;

/// Most model ids one probe hop reports. A provider can list hundreds
/// (OpenRouter-compatible gateways); the settings picker needs enough to choose
/// from, and the response must stay small.
pub const MAX_PROBE_MODEL_IDS: usize = 100;

/// The `guardrail` row's only accepted value until the 판정기 ADR is Accepted.
pub const GUARDRAIL_OFF: &str = "off";

/// The team rows this table stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultAiRole {
    TeamAgent,
    Summary,
}

impl DefaultAiRole {
    pub const ALL: [DefaultAiRole; 2] = [DefaultAiRole::TeamAgent, DefaultAiRole::Summary];

    pub fn as_str(self) -> &'static str {
        match self {
            DefaultAiRole::TeamAgent => "team_agent",
            DefaultAiRole::Summary => "summary",
        }
    }

    fn from_label(raw: &str) -> Option<DefaultAiRole> {
        DefaultAiRole::ALL
            .into_iter()
            .find(|role| role.as_str() == raw)
    }
}

/// One stored team row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDefaultAi {
    pub role: DefaultAiRole,
    pub link_position: i32,
    /// `redacted_endpoint_label` of the position when it was chosen.
    pub link_endpoint_label: String,
    pub model_id: Option<String>,
    pub updated_by_member_id: Option<Uuid>,
    pub updated_at_ms: i64,
}

/// A model id this server will store or repeat, or `None`.
///
/// Accepted: 1..=[`MAX_MODEL_ID_BYTES`] bytes of `[A-Za-z0-9._:/@+-]`, starting
/// with an ASCII letter or digit, after trimming. That covers every id shape the
/// supported providers publish (`gpt-5.4-codex`, `claude-sonnet-4-5-20250929`,
/// `anthropic/claude-sonnet-4.5:beta`, `x-ai/grok-4`) and rejects whitespace,
/// control characters, quotes, markup and anything long enough to smuggle a
/// sentence through a picker.
pub fn sanitized_model_id(raw: &str) -> Option<String> {
    let id = raw.trim();
    let first = id.chars().next()?;
    if id.len() > MAX_MODEL_ID_BYTES || !first.is_ascii_alphanumeric() {
        return None;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '+' | '-'))
        .then(|| id.to_string())
}

type DefaultAiRow = (String, i32, String, Option<String>, Option<Uuid>, i64);

/// Every stored team row. Runs inside `with_provider_link_admin_tx`.
pub async fn read_default_ai(conn: &mut PgConnection) -> Result<Vec<StoredDefaultAi>, DbError> {
    let rows: Vec<DefaultAiRow> = sqlx::query_as(
        "SELECT role, link_position, link_endpoint_label, model_id, updated_by, \
                floor(extract(epoch from updated_at) * 1000)::bigint \
           FROM provider_default_ai \
          ORDER BY role",
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(role, position, label, model_id, updated_by, at_ms)| {
            Some(StoredDefaultAi {
                role: DefaultAiRole::from_label(&role)?,
                link_position: position,
                link_endpoint_label: label,
                model_id,
                updated_by_member_id: updated_by,
                updated_at_ms: at_ms,
            })
        })
        .collect())
}

/// Insert or replace one team row. The caller has already validated the model
/// id and resolved the position's label; the SQL CHECKs are the second line.
pub async fn upsert_default_ai(
    conn: &mut PgConnection,
    role: DefaultAiRole,
    link_position: i32,
    link_endpoint_label: &str,
    model_id: Option<&str>,
    updated_by: Uuid,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO provider_default_ai \
           (role, credential_source, link_position, link_endpoint_label, model_id, \
            updated_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now()) \
         ON CONFLICT (role) DO UPDATE SET \
           credential_source = EXCLUDED.credential_source, \
           link_position = EXCLUDED.link_position, \
           link_endpoint_label = EXCLUDED.link_endpoint_label, \
           model_id = EXCLUDED.model_id, \
           updated_by = EXCLUDED.updated_by, \
           updated_at = greatest(clock_timestamp(), \
                                 provider_default_ai.updated_at + interval '1 millisecond')",
    )
    .bind(role.as_str())
    .bind(TEAM_LINK_SOURCE)
    .bind(link_position)
    .bind(link_endpoint_label)
    .bind(model_id)
    .bind(updated_by)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Clear one team row (back to "서버가 정한 값"). Returns whether a row existed.
pub async fn delete_default_ai(
    conn: &mut PgConnection,
    role: DefaultAiRole,
) -> Result<bool, DbError> {
    let removed = sqlx::query("DELETE FROM provider_default_ai WHERE role = $1")
        .bind(role.as_str())
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_id_shapes_are_kept() {
        for id in [
            "gpt-5.4-codex",
            "claude-sonnet-4-5-20250929",
            "anthropic/claude-sonnet-4.5:beta",
            "x-ai/grok-4",
            "meta-llama/llama-3.1-8b-instruct:free",
            "models/gemini-2.5-pro",
            "hermes-agent",
            "o3",
        ] {
            assert_eq!(sanitized_model_id(id).as_deref(), Some(id), "{id}");
        }
        assert_eq!(sanitized_model_id("  gpt-5  ").as_deref(), Some("gpt-5"));
    }

    #[test]
    fn anything_that_is_not_an_id_is_dropped() {
        for raw in [
            "",
            "   ",
            "gpt 5",
            "gpt-5\nx",
            "a\u{0}b",
            "<script>",
            "\"quoted\"",
            "-leading-dash",
            "/leading-slash",
            "모델",
            "id;rm -rf",
            "a\u{202e}b",
        ] {
            assert_eq!(sanitized_model_id(raw), None, "{raw:?}");
        }
        assert!(sanitized_model_id(&"m".repeat(MAX_MODEL_ID_BYTES)).is_some());
        assert_eq!(
            sanitized_model_id(&"m".repeat(MAX_MODEL_ID_BYTES + 1)),
            None
        );
    }

    #[test]
    fn role_labels_round_trip() {
        for role in DefaultAiRole::ALL {
            assert_eq!(DefaultAiRole::from_label(role.as_str()), Some(role));
        }
        assert_eq!(DefaultAiRole::from_label("guardrail"), None);
        assert_eq!(DefaultAiRole::from_label("app_command"), None);
    }
}
