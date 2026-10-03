//! Whether a DM with a hosted agent is delivered, and why not (ADR-0162 증보 2,
//! #2915).
//!
//! The authority is the SQL function `hosted_connection_channel_ids`
//! (migration 091): the selector's `hosted_channel_approved`, the inbox, the
//! gateway claim and the Agent Port identity all read it. This module only
//! **names** the outcome the selector already reached, for two readers:
//!
//! * the skip line (#2871) — which DM sentence is true;
//! * the composer hint (#2891) — which sentence to show before anyone types.
//!
//! Both are pure functions of a [`MentionCandidate`] (the same row the
//! selector decides on), so the hint cannot promise a reply the selector would
//! refuse.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::hosted_notice::HostedSkipReason;
use crate::mention::MentionCandidate;
use crate::subscription::{owner_only_gate, SubscriptionNoticeKind};

/// Which DM sentence is true when the selector found the DM unapproved.
///
/// `one_to_one`: the DM has exactly two active members (the agent and the
/// caller). Only then can the owner open it; a group DM or an agent with no
/// owner never opens (B1). An `owner_only` agent's non-owner never reaches
/// here — ADR-0193 D4 answers them first — but it is refused here too so the
/// function is safe on its own.
pub fn unapproved_dm_reason(
    one_to_one: bool,
    owner_member_id: Option<Uuid>,
    owner_only: bool,
    author_member_id: Uuid,
) -> HostedSkipReason {
    match owner_member_id {
        Some(owner) if one_to_one && !owner_only && owner != author_member_id => {
            HostedSkipReason::DirectMessageAwaitingOwner
        }
        _ => HostedSkipReason::DirectMessageNotApprovable,
    }
}

/// The delivery state of one 1:1 DM with an agent, as its human member sees
/// it. The wire strings are the `state` field of
/// `GET /v1/workspaces/{ws}/channels/{channel}/agent-dm-delivery`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedDmDelivery {
    /// A managed/BYOA agent — the DM rule delivers as it always has.
    NotHosted,
    /// A hosted agent whose connection covers this DM (the owner's own DM, or
    /// one the owner approved).
    Open,
    /// A 1:1 DM with someone other than the owner that the owner has not
    /// approved.
    AwaitingOwner,
    /// A subscription agent (`owner_only`) called by someone else.
    OwnerOnly,
    /// A group DM, or an agent with no owner.
    NotApprovable,
    /// No active, proved connection.
    ConnectionUnavailable,
    /// This server does not deliver to hosted runtimes at all.
    DeliveryDisabled,
    /// The subscription kill switch is off (ADR-0193 D6).
    SubscriptionDisabled,
    /// A Claude subscription agent on an instance that has not opted in
    /// (ADR-0193 D18, #3397). Same word as the mention skip reason, the work
    /// request 409 and `brainUnavailableReason`.
    ClaudeSubscriptionPaused,
}

impl HostedDmDelivery {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotHosted => "not_hosted",
            Self::Open => "open",
            Self::AwaitingOwner => "awaiting_owner",
            Self::OwnerOnly => "owner_only",
            Self::NotApprovable => "not_approvable",
            Self::ConnectionUnavailable => "connection_unavailable",
            Self::DeliveryDisabled => "delivery_disabled",
            Self::SubscriptionDisabled => "subscription_disabled",
            Self::ClaudeSubscriptionPaused => "claude_subscription_agent_paused",
        }
    }
}

/// The selector's own order (`route_agent_mentions_in_tx`): owner-only gate,
/// then the hosted delivery gate, then the live connection, then the room.
pub fn hosted_dm_delivery(
    agent: &MentionCandidate,
    caller_member_id: Uuid,
    one_to_one: bool,
    hosted_delivery_enabled: bool,
    subscription_agents_enabled: bool,
    claude_subscription_agents_enabled: bool,
) -> HostedDmDelivery {
    if let Some(kind) = owner_only_gate(
        agent.owner_only.as_ref(),
        caller_member_id,
        subscription_agents_enabled,
        claude_subscription_agents_enabled,
    ) {
        return match kind {
            SubscriptionNoticeKind::NonOwner => HostedDmDelivery::OwnerOnly,
            SubscriptionNoticeKind::ClaudePaused => HostedDmDelivery::ClaudeSubscriptionPaused,
            _ => HostedDmDelivery::SubscriptionDisabled,
        };
    }
    if !agent.hosted_delivery_disabled {
        return HostedDmDelivery::NotHosted;
    }
    if !hosted_delivery_enabled {
        return HostedDmDelivery::DeliveryDisabled;
    }
    if agent.hosted_active_connection_id.is_none() {
        return HostedDmDelivery::ConnectionUnavailable;
    }
    if agent.hosted_channel_approved {
        return HostedDmDelivery::Open;
    }
    match unapproved_dm_reason(
        one_to_one,
        agent
            .owner_member_id
            .filter(|_| agent.hosted_confirmed_by_owner),
        agent.owner_only.is_some(),
        caller_member_id,
    ) {
        HostedSkipReason::DirectMessageAwaitingOwner => HostedDmDelivery::AwaitingOwner,
        _ => HostedDmDelivery::NotApprovable,
    }
}

// ---------------------------------------------------------------------------
// The owner's approval list (ADR-0162 증보 2 B3)
// ---------------------------------------------------------------------------

/// The connection facts an approval decision needs, read under a row lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedDmConnection {
    pub connection_id: Uuid,
    pub agent_member_id: Uuid,
    pub status: String,
    pub owner_member_id: Option<Uuid>,
    pub owner_only: bool,
    pub approved_dm_channel_ids: Vec<Uuid>,
    /// Who confirmed (static) or consented (OAuth) this connection; `None`
    /// before that. ADR-0162 증보 2 B6: DMs ride only on an owner's confirm.
    pub confirmed_by: Option<Uuid>,
}

impl HostedDmConnection {
    /// Approvals are edited only while the connection can still deliver or is
    /// on its way there. A connection being torn down or gone keeps its list
    /// frozen (and a new connection starts empty).
    /// Confirmed by someone other than the owner: this connection carries no
    /// DM at all (B6), so the list is read-only and every row is closed.
    pub fn confirmed_by_non_owner(&self) -> bool {
        self.confirmed_by.is_some() && self.confirmed_by != self.owner_member_id
    }

    pub fn is_live(&self) -> bool {
        matches!(
            self.status.as_str(),
            "pairing_pending" | "detected" | "active"
        )
    }
}

/// Read (and lock, `FOR UPDATE` when `lock`) one connection with its agent's
/// owner and scope.
pub async fn load_hosted_dm_connection_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    lock: bool,
) -> Result<Option<HostedDmConnection>, DbError> {
    let sql = format!(
        "SELECT hc.id, hc.agent_member_id, hc.status, a.owner_human_id, \
                (a.invocation_scope = 'owner_only') AS owner_only, \
                hc.approved_dm_channel_ids, hc.confirmed_by \
           FROM hosted_agent_connection hc \
           JOIN agent a ON a.workspace_id = hc.workspace_id AND a.member_id = hc.agent_member_id \
          WHERE hc.workspace_id = $1 AND hc.id = $2{}",
        if lock { " FOR UPDATE OF hc" } else { "" }
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(connection_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(HostedDmConnection {
        connection_id: row.try_get("id")?,
        agent_member_id: row.try_get("agent_member_id")?,
        status: row.try_get("status")?,
        owner_member_id: row.try_get("owner_human_id")?,
        owner_only: row.try_get("owner_only")?,
        approved_dm_channel_ids: row.try_get("approved_dm_channel_ids")?,
        confirmed_by: row.try_get("confirmed_by")?,
    }))
}

/// One 1:1 DM between the agent and an active human, with its approval state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedDmRow {
    pub channel_id: Uuid,
    pub counterpart_member_id: Uuid,
    pub state: HostedDmApprovalState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedDmApprovalState {
    /// The owner's own DM — open by rule, not by a stored value (B2).
    Owner,
    /// Someone else's DM the owner opened (B3).
    Approved,
    /// Someone else's DM, closed (the default).
    Unapproved,
    /// Someone else's DM with a subscription agent — cannot be opened (B4).
    NotApprovable,
}

impl HostedDmApprovalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Approved => "approved",
            Self::Unapproved => "unapproved",
            Self::NotApprovable => "not_approvable",
        }
    }
}

/// The state of one DM row. Pure, so the listing and the write agree.
pub fn hosted_dm_approval_state(
    connection: &HostedDmConnection,
    channel_id: Uuid,
    counterpart_member_id: Uuid,
) -> HostedDmApprovalState {
    if connection.confirmed_by_non_owner() {
        HostedDmApprovalState::NotApprovable
    } else if connection.owner_member_id == Some(counterpart_member_id) {
        HostedDmApprovalState::Owner
    } else if connection.owner_only || connection.owner_member_id.is_none() {
        HostedDmApprovalState::NotApprovable
    } else if connection.approved_dm_channel_ids.contains(&channel_id) {
        HostedDmApprovalState::Approved
    } else {
        HostedDmApprovalState::Unapproved
    }
}

/// Every 1:1 DM (B1) the agent is in with an active human, oldest first.
///
/// The same shape as `hosted_connection_channel_ids` (migration 091): kind
/// `dm`, not archived, exactly two active members.
pub async fn list_hosted_agent_dms_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection: &HostedDmConnection,
) -> Result<Vec<HostedDmRow>, DbError> {
    let rows = sqlx::query(
        "SELECT c.id AS channel_id, pm.member_id AS counterpart_member_id \
           FROM membership am \
           JOIN channel c \
             ON c.workspace_id = am.workspace_id AND c.id = am.channel_id \
            AND c.kind = 'dm' AND c.archived_at IS NULL \
           JOIN membership pm \
             ON pm.workspace_id = am.workspace_id AND pm.channel_id = c.id \
            AND pm.member_id <> am.member_id AND pm.left_at IS NULL \
           JOIN member m \
             ON m.workspace_id = pm.workspace_id AND m.id = pm.member_id \
            AND m.kind = 'human' AND m.status = 'active' AND m.deleted_at IS NULL \
          WHERE am.workspace_id = $1 AND am.member_id = $2 AND am.left_at IS NULL \
            AND (SELECT count(*) FROM membership x \
                  WHERE x.workspace_id = c.workspace_id AND x.channel_id = c.id \
                    AND x.left_at IS NULL) = 2 \
          ORDER BY c.id",
    )
    .bind(workspace_id)
    .bind(connection.agent_member_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut dms = Vec::with_capacity(rows.len());
    for row in &rows {
        let channel_id: Uuid = row.try_get("channel_id")?;
        let counterpart_member_id: Uuid = row.try_get("counterpart_member_id")?;
        dms.push(HostedDmRow {
            channel_id,
            counterpart_member_id,
            state: hosted_dm_approval_state(connection, channel_id, counterpart_member_id),
        });
    }
    Ok(dms)
}

/// Why an approval write was refused. Every refusal happens before any write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedDmApprovalError {
    NotFound,
    /// Only the agent's owner decides (B3) — an admin who is not the owner
    /// does not.
    NotOwner,
    /// A subscription agent's DMs with others cannot be opened (B4).
    OwnerOnly,
    /// The connection is being torn down, expired or gone.
    NotLive,
    /// Not a 1:1 DM between this agent and an active human.
    NotOneToOneDm,
    /// The owner's own DM is open by rule; there is nothing to store.
    OwnerDm,
    /// Someone other than the owner confirmed this connection; it carries no
    /// DM until the owner pairs it again (B6).
    ConfirmedByNonOwner,
}

/// Open (`approve = true`) or close one DM for the connection. Returns the
/// connection as it now stands and whether anything changed (a repeat is a
/// no-op, not an error — the toggle is idempotent).
pub async fn set_hosted_dm_approval_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
    actor_member_id: Uuid,
    approve: bool,
) -> Result<Result<(HostedDmRow, bool), HostedDmApprovalError>, DbError> {
    let Some(connection) =
        load_hosted_dm_connection_in_tx(&mut *conn, workspace_id, connection_id, true).await?
    else {
        return Ok(Err(HostedDmApprovalError::NotFound));
    };
    if connection.owner_member_id != Some(actor_member_id) {
        return Ok(Err(HostedDmApprovalError::NotOwner));
    }
    if connection.owner_only && approve {
        return Ok(Err(HostedDmApprovalError::OwnerOnly));
    }
    if connection.confirmed_by_non_owner() && approve {
        return Ok(Err(HostedDmApprovalError::ConfirmedByNonOwner));
    }
    if !connection.is_live() {
        return Ok(Err(HostedDmApprovalError::NotLive));
    }
    let dms = list_hosted_agent_dms_in_tx(&mut *conn, workspace_id, &connection).await?;
    let Some(dm) = dms.into_iter().find(|dm| dm.channel_id == channel_id) else {
        // Closing a DM that is no longer 1:1 is still allowed, so a stale
        // approval can always be withdrawn.
        if !approve && connection.approved_dm_channel_ids.contains(&channel_id) {
            let changed =
                remove_dm_approval(&mut *conn, workspace_id, connection_id, channel_id).await?;
            // The audit row should still say whose DM this was: the earliest
            // human who joined it (review N4). Nil only if nobody is found.
            let counterpart: Option<Uuid> = sqlx::query_scalar(
                "SELECT ms.member_id FROM membership ms \
                   JOIN member m ON m.workspace_id = ms.workspace_id AND m.id = ms.member_id \
                  WHERE ms.workspace_id = $1 AND ms.channel_id = $2 AND m.kind = 'human' \
                  ORDER BY ms.joined_at, ms.member_id LIMIT 1",
            )
            .bind(workspace_id)
            .bind(channel_id)
            .fetch_optional(&mut *conn)
            .await?;
            return Ok(Ok((
                HostedDmRow {
                    channel_id,
                    counterpart_member_id: counterpart.unwrap_or_else(Uuid::nil),
                    state: HostedDmApprovalState::Unapproved,
                },
                changed,
            )));
        }
        return Ok(Err(HostedDmApprovalError::NotOneToOneDm));
    };
    if dm.state == HostedDmApprovalState::Owner {
        return Ok(Err(HostedDmApprovalError::OwnerDm));
    }
    let changed = if approve {
        sqlx::query(
            "UPDATE hosted_agent_connection \
                SET approved_dm_channel_ids = array_append(approved_dm_channel_ids, $3), \
                    updated_at = now() \
              WHERE workspace_id = $1 AND id = $2 \
                AND NOT ($3 = ANY(approved_dm_channel_ids))",
        )
        .bind(workspace_id)
        .bind(connection_id)
        .bind(channel_id)
        .execute(&mut *conn)
        .await?
        .rows_affected()
            > 0
    } else {
        remove_dm_approval(&mut *conn, workspace_id, connection_id, channel_id).await?
    };
    Ok(Ok((
        HostedDmRow {
            state: if approve {
                HostedDmApprovalState::Approved
            } else {
                HostedDmApprovalState::Unapproved
            },
            ..dm
        },
        changed,
    )))
}

async fn remove_dm_approval(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    connection_id: Uuid,
    channel_id: Uuid,
) -> Result<bool, DbError> {
    Ok(sqlx::query(
        "UPDATE hosted_agent_connection \
            SET approved_dm_channel_ids = array_remove(approved_dm_channel_ids, $3), \
                updated_at = now() \
          WHERE workspace_id = $1 AND id = $2 \
            AND $3 = ANY(approved_dm_channel_ids)",
    )
    .bind(workspace_id)
    .bind(connection_id)
    .bind(channel_id)
    .execute(&mut *conn)
    .await?
    .rows_affected()
        > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: Uuid = Uuid::from_u128(1);
    const OTHER: Uuid = Uuid::from_u128(2);

    #[test]
    fn only_a_non_owner_in_a_one_to_one_dm_waits_for_the_owner() {
        assert_eq!(
            unapproved_dm_reason(true, Some(OWNER), false, OTHER),
            HostedSkipReason::DirectMessageAwaitingOwner
        );
        // A group DM never opens.
        assert_eq!(
            unapproved_dm_reason(false, Some(OWNER), false, OTHER),
            HostedSkipReason::DirectMessageNotApprovable
        );
        // No owner → nobody can open it.
        assert_eq!(
            unapproved_dm_reason(true, None, false, OTHER),
            HostedSkipReason::DirectMessageNotApprovable
        );
        // A subscription agent's other DMs cannot be approved (B4).
        assert_eq!(
            unapproved_dm_reason(true, Some(OWNER), true, OTHER),
            HostedSkipReason::DirectMessageNotApprovable
        );
        // The owner's own DM is automatic; if it is somehow closed, asking
        // the owner to approve it would be a false sentence.
        assert_eq!(
            unapproved_dm_reason(true, Some(OWNER), false, OWNER),
            HostedSkipReason::DirectMessageNotApprovable
        );
    }

    #[test]
    fn the_owner_row_is_automatic_and_a_subscription_agent_opens_nothing_else() {
        let channel = Uuid::from_u128(9);
        let mut connection = HostedDmConnection {
            connection_id: Uuid::from_u128(7),
            agent_member_id: Uuid::from_u128(8),
            status: "active".into(),
            owner_member_id: Some(OWNER),
            owner_only: false,
            approved_dm_channel_ids: vec![],
            confirmed_by: Some(OWNER),
        };
        assert_eq!(
            hosted_dm_approval_state(&connection, channel, OWNER),
            HostedDmApprovalState::Owner
        );
        assert_eq!(
            hosted_dm_approval_state(&connection, channel, OTHER),
            HostedDmApprovalState::Unapproved
        );
        connection.approved_dm_channel_ids.push(channel);
        assert_eq!(
            hosted_dm_approval_state(&connection, channel, OTHER),
            HostedDmApprovalState::Approved
        );
        // A stored approval does not survive the agent being owner_only.
        connection.owner_only = true;
        assert_eq!(
            hosted_dm_approval_state(&connection, channel, OTHER),
            HostedDmApprovalState::NotApprovable
        );
        assert_eq!(
            hosted_dm_approval_state(&connection, channel, OWNER),
            HostedDmApprovalState::Owner
        );
    }

    #[test]
    fn wire_words_are_distinct() {
        let all = [
            HostedDmDelivery::NotHosted,
            HostedDmDelivery::Open,
            HostedDmDelivery::AwaitingOwner,
            HostedDmDelivery::OwnerOnly,
            HostedDmDelivery::NotApprovable,
            HostedDmDelivery::ConnectionUnavailable,
            HostedDmDelivery::DeliveryDisabled,
            HostedDmDelivery::SubscriptionDisabled,
        ];
        let mut words: Vec<&str> = all.iter().map(|state| state.as_str()).collect();
        words.sort_unstable();
        words.dedup();
        assert_eq!(words.len(), all.len());
    }
}
