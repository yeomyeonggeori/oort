//! The `owner_only` agent whose brain is its owner's personal API key
//! (#3396, ADR-0147 증보 2026-10-03, migration 117).
//!
//! An `owner_only` agent has exactly one brain: a subscription CLI
//! (`agent.subscription_harness`, ADR-0193) or the owner's own API key
//! (`agent.uses_owner_key`). This module owns the one transition that makes an
//! agent the second kind and the one read that tells the two apart. It reads no
//! key material: the key itself is resolved by `momo-settings`
//! (`read_owner_key_for_agent`), and only by the worker.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// Which `owner_only` kind an agent is, or that it is not `owner_only`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnerOnlyBrain {
    /// A workspace agent (or no such agent): not an `owner_only` agent.
    NotOwnerOnly,
    /// The owner's subscription CLI — hosted, never run by the worker.
    Subscription,
    /// The owner's personal API key — run by the worker, on that key only.
    OwnerKey,
}

pub async fn agent_owner_only_brain_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<OwnerOnlyBrain, DbError> {
    let row: Option<(String, bool)> = sqlx::query_as(
        "SELECT invocation_scope, uses_owner_key FROM agent \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(match row {
        Some((scope, true)) if scope == crate::subscription::INVOCATION_SCOPE_OWNER_ONLY => {
            OwnerOnlyBrain::OwnerKey
        }
        Some((scope, _)) if scope == crate::subscription::INVOCATION_SCOPE_OWNER_ONLY => {
            OwnerOnlyBrain::Subscription
        }
        _ => OwnerOnlyBrain::NotOwnerOnly,
    })
}

/// Make a freshly created agent the owner's personal-key agent. One way
/// (migration 117's trigger): the scope, owner and brain can never change again.
///
/// The WHERE clause is the whole authorization of the transition: the agent's
/// owner must be `owner_human_id` already, it must not be `owner_only` yet, and
/// it must carry no subscription harness. `false` = nothing matched.
pub async fn mark_agent_owner_key_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    owner_member_id: Uuid,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent SET invocation_scope = 'owner_only', uses_owner_key = true, \
                updated_at = now() \
          WHERE workspace_id = $1 AND member_id = $2 AND owner_human_id = $3 \
            AND invocation_scope = 'workspace' AND subscription_harness IS NULL",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(owner_member_id)
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() == 1)
}
