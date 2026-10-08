//! Personal agents (ADR-0198 증보 1 D7, #3591 P2).
//!
//! A personal agent is the owner's connected harness (Claude Code, Codex) turned
//! on under an alias: one `member.kind = 'agent'` row whose brain is the harness
//! running on the owner's own member host. It reuses the `owner_only` shape of
//! migration 089 (`invocation_scope`, `subscription_harness`, `owner_human_id`)
//! so T5's signed spawn (`work_spawns.rs`) accepts it without a branch of its own
//! and #3567 can convert an existing subscription agent in place. Migration 123
//! adds the two columns the read paths need to tell it apart from a hosted
//! subscription agent.
//!
//! * the alias **is** `member.handle`; `member_handle_uniq` makes it unique across
//!   humans, agents and switched-off agents alike;
//! * "off" is `member.status = 'suspended'` plus `personal_disabled_at`, so past
//!   messages keep their author and an owner can turn back on only what the owner
//!   turned off (an admin's suspension is not the owner's to undo);
//! * nothing here creates a hosted connection, a token, an `agent_profile` or a
//!   channel membership. The server never holds the harness's credentials, and
//!   how the alias joins a channel is P1's decision (ADR-0198 「열린 확인」).

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

use crate::subscription::SubscriptionHarness;

/// What a teammate sees in the roster: 「<owner name>의 개인 에이전트」.
pub fn personal_agent_label(owner_display_name: &str) -> String {
    format!("{}의 개인 에이전트", owner_display_name.trim())
}

/// One personal agent as the owner's own list shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonalAgentRow {
    pub id: Uuid,
    pub handle: String,
    pub display_name: String,
    pub harness: SubscriptionHarness,
    /// `member.status = 'active'`.
    pub enabled: bool,
    /// The owner switched it off (`personal_disabled_at`), as opposed to an
    /// administrator suspending the member.
    pub owner_disabled: bool,
}

fn row_from(
    (id, handle, display_name, harness, status, disabled): (
        Uuid,
        String,
        String,
        Option<String>,
        String,
        bool,
    ),
) -> Option<PersonalAgentRow> {
    Some(PersonalAgentRow {
        id,
        handle,
        display_name,
        harness: harness.as_deref().and_then(SubscriptionHarness::parse)?,
        enabled: status == "active",
        owner_disabled: disabled,
    })
}

const ROW_COLUMNS: &str = "m.id, m.handle, m.display_name, a.subscription_harness, \
     m.status::text, (a.personal_disabled_at IS NOT NULL)";

/// Serialize concurrent 켜기 calls of the same (owner, harness) so the lookup
/// and the insert after it are one decision. The partial unique index of
/// migration 123 is the backstop.
pub async fn lock_personal_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
    harness: SubscriptionHarness,
) -> Result<(), DbError> {
    let key = format!(
        "personal_agent:{workspace_id}:{owner_member_id}:{}",
        harness.as_str()
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1::text))")
        .bind(key)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The owner's personal agent for `harness`, switched off or not. Locked.
pub async fn find_owner_personal_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
    harness: SubscriptionHarness,
) -> Result<Option<PersonalAgentRow>, DbError> {
    let row = sqlx::query_as(&format!(
        "SELECT {ROW_COLUMNS} FROM agent a \
           JOIN member m ON m.id = a.member_id AND m.workspace_id = a.workspace_id \
          WHERE a.workspace_id = $1 AND a.owner_human_id = $2 \
            AND a.personal_agent AND a.subscription_harness = $3 \
            AND m.deleted_at IS NULL AND m.status::text <> 'deleted' \
          FOR UPDATE OF a"
    ))
    .bind(workspace_id)
    .bind(owner_member_id)
    .bind(harness.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.and_then(row_from))
}

/// The caller's own personal agents, oldest first.
pub async fn list_owner_personal_agents_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
) -> Result<Vec<PersonalAgentRow>, DbError> {
    let rows: Vec<(Uuid, String, String, Option<String>, String, bool)> = sqlx::query_as(&format!(
        "SELECT {ROW_COLUMNS} FROM agent a \
               JOIN member m ON m.id = a.member_id AND m.workspace_id = a.workspace_id \
              WHERE a.workspace_id = $1 AND a.owner_human_id = $2 \
                AND a.personal_agent AND m.deleted_at IS NULL \
              ORDER BY m.created_at, m.id"
    ))
    .bind(workspace_id)
    .bind(owner_member_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().filter_map(row_from).collect())
}

/// The personal agent `agent_member_id`, **only if** `owner_member_id` owns it.
/// Someone else's agent, a non-personal agent and a missing id are all `None`,
/// so a teammate cannot tell them apart. Locked.
pub async fn find_owned_personal_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<PersonalAgentRow>, DbError> {
    let row = sqlx::query_as(&format!(
        "SELECT {ROW_COLUMNS} FROM agent a \
           JOIN member m ON m.id = a.member_id AND m.workspace_id = a.workspace_id \
          WHERE a.workspace_id = $1 AND a.member_id = $2 AND a.owner_human_id = $3 \
            AND a.personal_agent AND m.deleted_at IS NULL \
          FOR UPDATE OF a"
    ))
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(owner_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.and_then(row_from))
}

/// Why [`mark_personal_agent_in_tx`] did not mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkOutcome {
    Marked,
    /// Someone else's, a workspace-scope (team-callable hosted or external-card)
    /// agent, another harness, a personal-key agent, already personal, dead or
    /// not an agent: one answer.
    NotConvertible,
    /// A hosted connection or a live credential is still attached. Revoking
    /// them is #3567's step, not this call's.
    ConnectionsRemain,
}

/// Mark the caller's own, live, not yet personal `owner_only` agent of `harness`
/// as a personal agent. The caller creates a fresh identity first with
/// [`crate::mark_agent_owner_only_in_tx`]; a `workspace`-scope agent is never
/// converted here (it is team-callable, and may be a hosted or external-card
/// runtime). The member id, handle and every past message stay.
pub async fn mark_personal_agent_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    owner_member_id: Uuid,
    agent_member_id: Uuid,
    harness: SubscriptionHarness,
) -> Result<MarkOutcome, DbError> {
    let eligible: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM agent a \
          WHERE a.workspace_id = $1 AND a.member_id = $2 AND a.owner_human_id = $3 \
            AND NOT a.personal_agent AND NOT a.uses_owner_key \
            AND a.invocation_scope = 'owner_only' AND a.subscription_harness = $4 \
            AND EXISTS (SELECT 1 FROM member m \
                         WHERE m.workspace_id = a.workspace_id AND m.id = a.member_id \
                           AND m.kind = 'agent' AND m.status = 'active' AND m.deleted_at IS NULL) \
            FOR UPDATE OF a",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(owner_member_id)
    .bind(harness.as_str())
    .fetch_optional(&mut *conn)
    .await?;
    if eligible.is_none() {
        return Ok(MarkOutcome::NotConvertible);
    }
    let attached: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hosted_agent_connection hc \
                         WHERE hc.workspace_id = $1 AND hc.agent_member_id = $2 \
                           AND hc.status NOT IN ('expired', 'disconnected')) \
             OR EXISTS (SELECT 1 FROM token t \
                         WHERE t.workspace_id = $1 AND t.actor_member_id = $2 \
                           AND t.revoked_at IS NULL \
                           AND (t.expires_at IS NULL OR t.expires_at > now()))",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_one(&mut *conn)
    .await?;
    if attached {
        return Ok(MarkOutcome::ConnectionsRemain);
    }
    sqlx::query(
        "UPDATE agent SET personal_agent = true, personal_disabled_at = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .execute(&mut *conn)
    .await?;
    Ok(MarkOutcome::Marked)
}

/// Switch a personal agent on or off. Off: `member.status = 'suspended'` and
/// `personal_disabled_at = now()`. On: only a row the owner switched off
/// (`personal_disabled_at` set) comes back. `false` when nothing matched.
pub async fn set_personal_agent_enabled_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    enabled: bool,
) -> Result<bool, DbError> {
    let (member_sql, agent_sql) = if enabled {
        (
            "UPDATE member m SET status = 'active', updated_at = now() \
              WHERE m.workspace_id = $1 AND m.id = $2 AND m.kind = 'agent' \
                AND m.status = 'suspended' AND m.deleted_at IS NULL \
                AND EXISTS (SELECT 1 FROM agent a WHERE a.workspace_id = m.workspace_id \
                              AND a.member_id = m.id AND a.personal_agent \
                              AND a.personal_disabled_at IS NOT NULL)",
            "UPDATE agent SET personal_disabled_at = NULL, updated_at = now() \
              WHERE workspace_id = $1 AND member_id = $2 AND personal_agent",
        )
    } else {
        (
            "UPDATE member m SET status = 'suspended', updated_at = now() \
              WHERE m.workspace_id = $1 AND m.id = $2 AND m.kind = 'agent' \
                AND m.status = 'active' AND m.deleted_at IS NULL \
                AND EXISTS (SELECT 1 FROM agent a WHERE a.workspace_id = m.workspace_id \
                              AND a.member_id = m.id AND a.personal_agent)",
            "UPDATE agent SET personal_disabled_at = now(), updated_at = now() \
              WHERE workspace_id = $1 AND member_id = $2 AND personal_agent",
        )
    };
    // The member trigger (migration 123) clears `personal_disabled_at` for any
    // status write that is not this owner toggle.
    sqlx::query("SELECT set_config('momo.personal_owner_toggle', 'on', true)")
        .execute(&mut *conn)
        .await?;
    let changed = sqlx::query(member_sql)
        .bind(workspace_id)
        .bind(agent_member_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    sqlx::query("SELECT set_config('momo.personal_owner_toggle', 'off', true)")
        .execute(&mut *conn)
        .await?;
    if changed != 1 {
        return Ok(false);
    }
    sqlx::query(agent_sql)
        .bind(workspace_id)
        .bind(agent_member_id)
        .execute(&mut *conn)
        .await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_names_the_owner() {
        assert_eq!(personal_agent_label("kwak"), "kwak의 개인 에이전트");
        assert_eq!(personal_agent_label("  성재 "), "성재의 개인 에이전트");
    }
}
