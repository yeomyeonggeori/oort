//! 에이전트별 AI 연결 고정 — `agent_provider_pin` (migration 136, #3873, ADR-0147
//! 증보 2026-10-16).
//!
//! The team default AI follows the instance's head link. A pin takes **one agent**
//! off that road: it names the link the agent calls, whatever the team default is.
//! That is what lets a team Anthropic key (`provider_link`) and a co-hosted
//! Hermes (`HERMES_BASE_URL`) live in one instance.
//!
//! A pin is a **reference**, never a credential or a URL:
//!
//! | kind | names | stored |
//! |---|---|---|
//! | [`PinKind::OperatorEnv`] | the operator's env link (`HERMES_BASE_URL`) | nothing else |
//! | [`PinKind::TeamLink`] | a cascade position (0 = the `provider_link` singleton **itself**, never its env fallback; 1+ = a `provider_link_chain` hop) | the position and the redacted endpoint label it had |
//!
//! No admin types a host: the pin selects a hop that already passed
//! `validated_base_url` or the operator's own env host, so the egress rules are
//! exactly what they were. Reads happen in a tenant transaction (the picker shows
//! the pin); every write happens inside `with_provider_link_admin_tx`, because the
//! table's write policies require `app.provider_link_admin = 'on'`.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// What a pin names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinKind {
    /// The operator's env link.
    OperatorEnv,
    /// A cascade position of the team link store.
    TeamLink,
}

impl PinKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PinKind::OperatorEnv => "operator_env",
            PinKind::TeamLink => "team_link",
        }
    }

    pub fn from_label(raw: &str) -> Option<PinKind> {
        [PinKind::OperatorEnv, PinKind::TeamLink]
            .into_iter()
            .find(|kind| kind.as_str() == raw)
    }
}

/// One stored pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAgentPin {
    pub agent_member_id: Uuid,
    pub kind: PinKind,
    /// `Some` exactly for [`PinKind::TeamLink`].
    pub link_position: Option<i32>,
    /// `redacted_endpoint_label` of the position when it was chosen.
    pub link_endpoint_label: Option<String>,
    pub pinned_by_member_id: Option<Uuid>,
    pub updated_at_ms: i64,
}

type PinRow = (Uuid, String, Option<i32>, Option<String>, Option<Uuid>, i64);

fn stored(row: PinRow) -> Option<StoredAgentPin> {
    let (agent_member_id, kind, link_position, link_endpoint_label, pinned_by, updated_at_ms) = row;
    Some(StoredAgentPin {
        agent_member_id,
        // A kind this build does not know is a pin it cannot honour; the callers
        // treat `None` here as "unreadable", never as "no pin".
        kind: PinKind::from_label(&kind)?,
        link_position,
        link_endpoint_label,
        pinned_by_member_id: pinned_by,
        updated_at_ms,
    })
}

/// Why a stored pin could not be read.
#[derive(Debug)]
pub enum PinReadError {
    Db(DbError),
    /// The row exists but names a kind this build does not know. The worker must
    /// refuse the turn: treating it as "no pin" would send a pinned agent to the
    /// team's key.
    UnknownKind,
}

impl From<DbError> for PinReadError {
    fn from(error: DbError) -> Self {
        PinReadError::Db(error)
    }
}

impl From<sqlx::Error> for PinReadError {
    fn from(error: sqlx::Error) -> Self {
        PinReadError::Db(error.into())
    }
}

const SELECT: &str = "SELECT agent_member_id, kind, link_position, link_endpoint_label, \
                             pinned_by, floor(extract(epoch from updated_at) * 1000)::bigint \
                        FROM agent_provider_pin";

/// The pin of one agent, or `None` when it follows the team default. A tenant
/// transaction of `workspace_id` (RLS) or the BYPASSRLS worker.
pub async fn read_agent_pin(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<StoredAgentPin>, PinReadError> {
    let row: Option<PinRow> = sqlx::query_as(&format!(
        "{SELECT} WHERE workspace_id = $1 AND agent_member_id = $2"
    ))
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        None => Ok(None),
        Some(row) => stored(row).map(Some).ok_or(PinReadError::UnknownKind),
    }
}

/// Insert or replace one pin. Only inside `with_provider_link_admin_tx`; the
/// caller has already resolved the position's label. The table's CHECKs, trigger
/// and write policy are the second line.
pub async fn upsert_agent_pin(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    kind: PinKind,
    link_position: Option<i32>,
    link_endpoint_label: Option<&str>,
    pinned_by: Uuid,
) -> Result<StoredAgentPin, DbError> {
    let row: PinRow = sqlx::query_as(
        "INSERT INTO agent_provider_pin \
           (agent_member_id, workspace_id, kind, link_position, link_endpoint_label, \
            pinned_by, pinned_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now(), now()) \
         ON CONFLICT (agent_member_id) DO UPDATE SET \
           kind = EXCLUDED.kind, \
           link_position = EXCLUDED.link_position, \
           link_endpoint_label = EXCLUDED.link_endpoint_label, \
           pinned_by = EXCLUDED.pinned_by, \
           updated_at = greatest(clock_timestamp(), \
                                 agent_provider_pin.updated_at + interval '1 millisecond') \
         RETURNING agent_member_id, kind, link_position, link_endpoint_label, pinned_by, \
                   floor(extract(epoch from updated_at) * 1000)::bigint",
    )
    .bind(agent_member_id)
    .bind(workspace_id)
    .bind(kind.as_str())
    .bind(link_position)
    .bind(link_endpoint_label)
    .bind(pinned_by)
    .fetch_one(&mut *conn)
    .await?;
    // The kind we just wrote is one we know.
    Ok(stored(row).expect("a kind written by this build parses"))
}

/// Remove one pin (the agent follows the team default again). Returns whether a
/// row existed.
pub async fn delete_agent_pin(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    let removed = sqlx::query(
        "DELETE FROM agent_provider_pin WHERE workspace_id = $1 AND agent_member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_labels_round_trip_and_unknown_is_not_a_kind() {
        for kind in [PinKind::OperatorEnv, PinKind::TeamLink] {
            assert_eq!(PinKind::from_label(kind.as_str()), Some(kind));
        }
        for raw in ["", "env", "TEAM_LINK", "personal", "subscription"] {
            assert_eq!(PinKind::from_label(raw), None, "{raw}");
        }
    }

    #[test]
    fn an_unknown_stored_kind_is_unreadable_not_absent() {
        let row: PinRow = (Uuid::nil(), "future_kind".into(), None, None, None, 1);
        assert!(stored(row).is_none());
    }
}
