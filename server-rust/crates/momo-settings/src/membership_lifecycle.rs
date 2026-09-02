//! ADR-0128 D2/D3 membership lifecycle mutations.
//!
//! Port of Swift `MemberLifecycleRoutes` domain writes. Authorization is judged
//! here — actor and target roles are loaded in the same tenant transaction —
//! so a route-layer admin check is never the authority (#1798 pattern).

use momo_auth::{active_workspace_role, active_workspace_role_for_update, WorkspaceRole};
use momo_db::{DbError, PgConnection};
use sqlx::Row;
use uuid::Uuid;

use crate::join::{normalized_join_email, normalized_requested_handle, JoinSpecInvalid};
use crate::workspace::{
    lock_membership_mutation, revoke_member_tokens_in_tx, terminate_workspace_membership_in_tx,
    workspace_has_another_active_owner, RevokedTokens,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MembershipLifecycleError {
    NotActiveMember,
    WorkspaceAdminRequired,
    ChannelAdminRequired,
    CannotManageSelf,
    CannotManageEqualOrHigher,
    AdminsCannotGrantAdminOrOwner,
    MemberNotFound,
    ChannelMembershipNotFound,
    BanNotFound,
    DirectMessageLeaveForbidden,
    LastOwner,
    StatusMustBe(&'static str),
    BanExists,
    InvalidStoredRole,
    EmailOrHandleRequired,
    InvalidEmail,
    InvalidHandle,
    AgentRoleImmutable,
}

impl MembershipLifecycleError {
    pub fn as_swift_message(&self) -> &'static str {
        match self {
            Self::NotActiveMember => "not an active workspace member",
            Self::WorkspaceAdminRequired => "workspace admin required",
            Self::ChannelAdminRequired => "channel admin required",
            Self::CannotManageSelf => "members cannot manage themselves",
            Self::CannotManageEqualOrHigher => "cannot manage an equal or higher role",
            Self::AdminsCannotGrantAdminOrOwner => "admins cannot grant admin or owner",
            Self::MemberNotFound => "workspace member not found",
            Self::ChannelMembershipNotFound => "active channel membership not found",
            Self::BanNotFound => "ban not found",
            Self::DirectMessageLeaveForbidden => "direct message channels cannot be left",
            Self::LastOwner => "workspace must retain at least one owner",
            Self::StatusMustBe("active") => "member status must be active",
            Self::StatusMustBe("suspended") => "member status must be suspended",
            Self::StatusMustBe(_) => "member status must be active",
            Self::BanExists => "matching workspace ban already exists",
            Self::InvalidStoredRole => "invalid stored workspace role",
            Self::EmailOrHandleRequired => "email or handle is required",
            Self::InvalidEmail => "email is invalid",
            Self::InvalidHandle => "handle must be 2-32 chars of a-z, 0-9, _ or -",
            Self::AgentRoleImmutable => "agent roles are fixed to member",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTransition {
    Suspend,
    Reinstate,
}

impl StatusTransition {
    pub fn expected(self) -> &'static str {
        match self {
            Self::Suspend => "active",
            Self::Reinstate => "suspended",
        }
    }

    pub fn next(self) -> &'static str {
        match self {
            Self::Suspend => "suspended",
            Self::Reinstate => "active",
        }
    }

    pub fn action(self) -> &'static str {
        match self {
            Self::Suspend => "member.suspended",
            Self::Reinstate => "member.reinstated",
        }
    }
}

#[derive(Debug, Clone)]
pub struct MembershipTarget {
    pub membership_id: Uuid,
    pub role: WorkspaceRole,
    pub kind: String,
    pub status: String,
    pub email: Option<String>,
    pub handle: String,
}

#[derive(Debug, Clone)]
pub struct RoleChangeApplied {
    pub membership_id: Uuid,
    pub old_role: WorkspaceRole,
    pub new_role: WorkspaceRole,
}

#[derive(Debug, Clone)]
pub struct ChannelRoleApplied {
    pub membership_id: Uuid,
    pub channel_id: Uuid,
    pub old_role: WorkspaceRole,
    pub new_role: WorkspaceRole,
}

#[derive(Debug, Clone)]
pub struct StatusChangeApplied {
    pub old_status: String,
    pub new_status: String,
    pub revoked: RevokedTokens,
}

#[derive(Debug, Clone)]
pub struct RemoveApplied {
    pub old_status: String,
    pub banned: bool,
    pub revoked: RevokedTokens,
}

#[derive(Debug, Clone)]
pub struct BanRecord {
    pub id: Uuid,
    pub email: Option<String>,
    pub handle: Option<String>,
    pub created_by: Uuid,
    pub reason: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ChannelLeaveApplied {
    pub membership_id: Uuid,
    pub channel_id: Uuid,
    pub kind: String,
    pub archived: bool,
}

pub fn normalized_reason(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(500).collect())
}

pub fn normalize_ban_identity(
    email: Option<&str>,
    handle: Option<&str>,
) -> Result<(Option<String>, Option<String>), MembershipLifecycleError> {
    let email = match email {
        Some(raw) => Some(normalized_join_email(raw).map_err(|error| match error {
            JoinSpecInvalid::Email => MembershipLifecycleError::InvalidEmail,
            _ => MembershipLifecycleError::InvalidEmail,
        })?),
        None => None,
    };
    let handle = match handle {
        Some(raw) => normalized_requested_handle(Some(raw)).map_err(|error| match error {
            JoinSpecInvalid::Handle => MembershipLifecycleError::InvalidHandle,
            _ => MembershipLifecycleError::InvalidHandle,
        })?,
        None => None,
    };
    if email.is_none() && handle.is_none() {
        return Err(MembershipLifecycleError::EmailOrHandleRequired);
    }
    Ok((email, handle))
}

async fn require_active_member(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    for_update: bool,
) -> Result<Result<WorkspaceRole, MembershipLifecycleError>, DbError> {
    let role = if for_update {
        active_workspace_role_for_update(conn, workspace_id, member_id).await?
    } else {
        active_workspace_role(conn, workspace_id, member_id).await?
    };
    Ok(match role {
        Some(role) => Ok(role),
        None => Err(MembershipLifecycleError::NotActiveMember),
    })
}

async fn require_workspace_admin(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    for_update: bool,
) -> Result<Result<WorkspaceRole, MembershipLifecycleError>, DbError> {
    Ok(
        match require_active_member(conn, workspace_id, member_id, for_update).await? {
            Ok(role) if role.is_admin() => Ok(role),
            Ok(_) => Err(MembershipLifecycleError::WorkspaceAdminRequired),
            Err(error) => Err(error),
        },
    )
}

async fn load_target(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Result<MembershipTarget, MembershipLifecycleError>, DbError> {
    let row = sqlx::query(
        "SELECT wm.id, wm.role::text, m.kind::text, m.status::text, h.email, m.handle \
           FROM workspace_membership wm \
           JOIN member m ON m.workspace_id = wm.workspace_id AND m.id = wm.member_id \
           LEFT JOIN human h ON h.workspace_id = m.workspace_id AND h.member_id = m.id \
          WHERE wm.workspace_id = $1 AND wm.member_id = $2 \
          FOR UPDATE OF wm, m",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(Err(MembershipLifecycleError::MemberNotFound));
    };
    let role_raw: String = row.try_get("role")?;
    let Some(role) = WorkspaceRole::from_db_label(&role_raw) else {
        return Ok(Err(MembershipLifecycleError::InvalidStoredRole));
    };
    Ok(Ok(MembershipTarget {
        membership_id: row.try_get("id")?,
        role,
        kind: row.try_get("kind")?,
        status: row.try_get("status")?,
        email: row.try_get("email")?,
        handle: row.try_get("handle")?,
    }))
}

fn require_can_manage(
    actor_id: Uuid,
    actor_role: WorkspaceRole,
    target_id: Uuid,
    target_role: WorkspaceRole,
    requested_role: Option<WorkspaceRole>,
) -> Result<(), MembershipLifecycleError> {
    if actor_id == target_id {
        return Err(MembershipLifecycleError::CannotManageSelf);
    }
    let allowed = if requested_role.is_some() {
        actor_role.can_change_role_of(target_role)
    } else {
        actor_role.can_suspend(target_role) && actor_role.can_remove(target_role)
    };
    if !allowed {
        return Err(MembershipLifecycleError::CannotManageEqualOrHigher);
    }
    if let Some(requested) = requested_role {
        if !actor_role.can_grant_role(requested) {
            return Err(MembershipLifecycleError::AdminsCannotGrantAdminOrOwner);
        }
    }
    Ok(())
}

async fn refuse_last_owner(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    excluding: Uuid,
) -> Result<Result<(), MembershipLifecycleError>, DbError> {
    if workspace_has_another_active_owner(conn, workspace_id, excluding).await? {
        Ok(Ok(()))
    } else {
        Ok(Err(MembershipLifecycleError::LastOwner))
    }
}

pub async fn change_workspace_role_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_id: Uuid,
    target_id: Uuid,
    requested: WorkspaceRole,
) -> Result<Result<RoleChangeApplied, MembershipLifecycleError>, DbError> {
    lock_membership_mutation(conn, workspace_id).await?;
    let actor_role = match require_workspace_admin(conn, workspace_id, actor_id, true).await? {
        Ok(role) => role,
        Err(error) => return Ok(Err(error)),
    };
    let target = match load_target(conn, workspace_id, target_id).await? {
        Ok(target) => target,
        Err(error) => return Ok(Err(error)),
    };
    if target.kind == "agent" {
        return Ok(Err(MembershipLifecycleError::AgentRoleImmutable));
    }
    if target.role == WorkspaceRole::Owner && requested != WorkspaceRole::Owner {
        if let Err(error) = refuse_last_owner(conn, workspace_id, target_id).await? {
            return Ok(Err(error));
        }
    }
    if let Err(error) = require_can_manage(
        actor_id,
        actor_role,
        target_id,
        target.role,
        Some(requested),
    ) {
        return Ok(Err(error));
    }
    sqlx::query(
        "UPDATE workspace_membership \
            SET role = $3::membership_role, updated_at = now() \
          WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(target_id)
    .bind(requested.as_db_label())
    .execute(&mut *conn)
    .await?;
    Ok(Ok(RoleChangeApplied {
        membership_id: target.membership_id,
        old_role: target.role,
        new_role: requested,
    }))
}

pub async fn change_channel_role_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    actor_id: Uuid,
    target_id: Uuid,
    requested: WorkspaceRole,
) -> Result<Result<ChannelRoleApplied, MembershipLifecycleError>, DbError> {
    lock_membership_mutation(conn, workspace_id).await?;
    let workspace_role = match require_active_member(conn, workspace_id, actor_id, true).await? {
        Ok(role) => role,
        Err(error) => return Ok(Err(error)),
    };
    let row = sqlx::query(
        "SELECT target.id, target.role::text, actor.role::text AS actor_channel_role \
           FROM membership target \
           JOIN channel c \
             ON c.id = target.channel_id AND c.workspace_id = target.workspace_id \
           LEFT JOIN membership actor \
             ON actor.channel_id = target.channel_id \
            AND actor.member_id = $3 \
            AND actor.left_at IS NULL \
          WHERE target.workspace_id = $1 \
            AND target.channel_id = $2 \
            AND target.member_id = $4 \
            AND target.left_at IS NULL \
            AND c.archived_at IS NULL \
          FOR UPDATE OF target",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(actor_id)
    .bind(target_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(Err(MembershipLifecycleError::ChannelMembershipNotFound));
    };
    let target_raw: String = row.try_get("role")?;
    let Some(target_role) = WorkspaceRole::from_db_label(&target_raw) else {
        return Ok(Err(MembershipLifecycleError::InvalidStoredRole));
    };
    let actor_role = if workspace_role.is_admin() {
        workspace_role
    } else {
        let channel_raw: Option<String> = row.try_get("actor_channel_role")?;
        match channel_raw
            .as_deref()
            .and_then(WorkspaceRole::from_db_label)
        {
            Some(channel_role) if channel_role.is_admin() => channel_role,
            _ => return Ok(Err(MembershipLifecycleError::ChannelAdminRequired)),
        }
    };
    if let Err(error) = require_can_manage(
        actor_id,
        actor_role,
        target_id,
        target_role,
        Some(requested),
    ) {
        return Ok(Err(error));
    }
    let membership_id: Uuid = row.try_get("id")?;
    sqlx::query("UPDATE membership SET role = $2::membership_role WHERE id = $1")
        .bind(membership_id)
        .bind(requested.as_db_label())
        .execute(&mut *conn)
        .await?;
    Ok(Ok(ChannelRoleApplied {
        membership_id,
        channel_id,
        old_role: target_role,
        new_role: requested,
    }))
}

pub async fn set_member_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_id: Uuid,
    target_id: Uuid,
    transition: StatusTransition,
) -> Result<Result<StatusChangeApplied, MembershipLifecycleError>, DbError> {
    lock_membership_mutation(conn, workspace_id).await?;
    let actor_role = match require_workspace_admin(conn, workspace_id, actor_id, true).await? {
        Ok(role) => role,
        Err(error) => return Ok(Err(error)),
    };
    let target = match load_target(conn, workspace_id, target_id).await? {
        Ok(target) => target,
        Err(error) => return Ok(Err(error)),
    };
    if target.role == WorkspaceRole::Owner && transition.next() != "active" {
        if let Err(error) = refuse_last_owner(conn, workspace_id, target_id).await? {
            return Ok(Err(error));
        }
    }
    if let Err(error) = require_can_manage(actor_id, actor_role, target_id, target.role, None) {
        return Ok(Err(error));
    }
    if target.status != transition.expected() {
        return Ok(Err(MembershipLifecycleError::StatusMustBe(
            transition.expected(),
        )));
    }
    sqlx::query("UPDATE member SET status = $2::member_status, updated_at = now() WHERE id = $1")
        .bind(target_id)
        .bind(transition.next())
        .execute(&mut *conn)
        .await?;
    let revoked = if transition == StatusTransition::Suspend {
        revoke_member_tokens_in_tx(conn, workspace_id, target_id).await?
    } else {
        RevokedTokens::default()
    };
    Ok(Ok(StatusChangeApplied {
        old_status: transition.expected().to_string(),
        new_status: transition.next().to_string(),
        revoked,
    }))
}

pub async fn remove_workspace_member_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_id: Uuid,
    target_id: Uuid,
    ban: bool,
    reason: Option<&str>,
) -> Result<Result<RemoveApplied, MembershipLifecycleError>, DbError> {
    lock_membership_mutation(conn, workspace_id).await?;
    let actor_role = match require_workspace_admin(conn, workspace_id, actor_id, true).await? {
        Ok(role) => role,
        Err(error) => return Ok(Err(error)),
    };
    let target = match load_target(conn, workspace_id, target_id).await? {
        Ok(target) => target,
        Err(error) => return Ok(Err(error)),
    };
    if target.role == WorkspaceRole::Owner {
        if let Err(error) = refuse_last_owner(conn, workspace_id, target_id).await? {
            return Ok(Err(error));
        }
    }
    if let Err(error) = require_can_manage(actor_id, actor_role, target_id, target.role, None) {
        return Ok(Err(error));
    }
    if ban {
        if let Err(error) = insert_ban(
            conn,
            workspace_id,
            actor_id,
            target.email.as_deref(),
            Some(target.handle.as_str()),
            normalized_reason(reason).as_deref(),
        )
        .await?
        {
            return Ok(Err(error));
        }
    }
    let revoked = revoke_member_tokens_in_tx(conn, workspace_id, target_id).await?;
    terminate_workspace_membership_in_tx(conn, workspace_id, target_id).await?;
    Ok(Ok(RemoveApplied {
        old_status: target.status,
        banned: ban,
        revoked,
    }))
}

pub async fn create_workspace_ban_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_id: Uuid,
    email: Option<&str>,
    handle: Option<&str>,
    reason: Option<&str>,
) -> Result<Result<BanRecord, MembershipLifecycleError>, DbError> {
    let actor_role = match require_workspace_admin(conn, workspace_id, actor_id, true).await? {
        Ok(role) => role,
        Err(error) => return Ok(Err(error)),
    };
    if !actor_role.can_ban() {
        return Ok(Err(MembershipLifecycleError::WorkspaceAdminRequired));
    }
    insert_ban(
        conn,
        workspace_id,
        actor_id,
        email,
        handle,
        normalized_reason(reason).as_deref(),
    )
    .await
}

pub async fn list_workspace_bans_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_id: Uuid,
) -> Result<Result<Vec<BanRecord>, MembershipLifecycleError>, DbError> {
    let actor_role = match require_workspace_admin(conn, workspace_id, actor_id, false).await? {
        Ok(role) => role,
        Err(error) => return Ok(Err(error)),
    };
    if !actor_role.can_ban() {
        return Ok(Err(MembershipLifecycleError::WorkspaceAdminRequired));
    }
    let rows = sqlx::query(
        "SELECT id, email_norm, handle_norm, created_by, reason, \
                (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms \
           FROM workspace_ban \
          WHERE workspace_id = $1 \
          ORDER BY created_at DESC, id \
          LIMIT 500",
    )
    .bind(workspace_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut bans = Vec::with_capacity(rows.len());
    for row in rows {
        bans.push(decode_ban(&row)?);
    }
    Ok(Ok(bans))
}

pub async fn delete_workspace_ban_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_id: Uuid,
    ban_id: Uuid,
) -> Result<Result<BanRecord, MembershipLifecycleError>, DbError> {
    let actor_role = match require_workspace_admin(conn, workspace_id, actor_id, true).await? {
        Ok(role) => role,
        Err(error) => return Ok(Err(error)),
    };
    if !actor_role.can_ban() {
        return Ok(Err(MembershipLifecycleError::WorkspaceAdminRequired));
    }
    let row = sqlx::query(
        "DELETE FROM workspace_ban \
          WHERE workspace_id = $1 AND id = $2 \
        RETURNING id, email_norm, handle_norm, created_by, reason, \
                  (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms",
    )
    .bind(workspace_id)
    .bind(ban_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Ok(decode_ban(&row)?)),
        None => Ok(Err(MembershipLifecycleError::BanNotFound)),
    }
}

pub async fn leave_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<Result<ChannelLeaveApplied, MembershipLifecycleError>, DbError> {
    if let Err(error) = require_active_member(conn, workspace_id, member_id, true).await? {
        return Ok(Err(error));
    }
    let row = sqlx::query(
        "SELECT ms.id, c.kind::text \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = ms.workspace_id \
          WHERE ms.workspace_id = $1 \
            AND ms.channel_id = $2 \
            AND ms.member_id = $3 \
            AND ms.left_at IS NULL \
            AND c.archived_at IS NULL \
          FOR UPDATE OF ms, c",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(Err(MembershipLifecycleError::ChannelMembershipNotFound));
    };
    let membership_id: Uuid = row.try_get("id")?;
    let kind: String = row.try_get("kind")?;
    if kind == "dm" {
        return Ok(Err(MembershipLifecycleError::DirectMessageLeaveForbidden));
    }
    sqlx::query("UPDATE membership SET left_at = now() WHERE id = $1")
        .bind(membership_id)
        .execute(&mut *conn)
        .await?;
    let mut archived = false;
    if kind == "private" {
        let remaining: bool = sqlx::query_scalar(
            "SELECT EXISTS ( \
               SELECT 1 FROM membership \
                WHERE workspace_id = $1 \
                  AND channel_id = $2 \
                  AND left_at IS NULL)",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .fetch_one(&mut *conn)
        .await?;
        if !remaining {
            sqlx::query(
                "UPDATE channel \
                    SET archived_at = COALESCE(archived_at, now()), updated_at = now() \
                  WHERE workspace_id = $1 AND id = $2",
            )
            .bind(workspace_id)
            .bind(channel_id)
            .execute(&mut *conn)
            .await?;
            archived = true;
        }
    }
    Ok(Ok(ChannelLeaveApplied {
        membership_id,
        channel_id,
        kind,
        archived,
    }))
}

async fn insert_ban(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    created_by: Uuid,
    email: Option<&str>,
    handle: Option<&str>,
    reason: Option<&str>,
) -> Result<Result<BanRecord, MembershipLifecycleError>, DbError> {
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM workspace_ban \
            WHERE workspace_id = $1 \
              AND (($2::text IS NOT NULL AND email_norm = $2) \
                OR ($3::text IS NOT NULL AND handle_norm = $3)))",
    )
    .bind(workspace_id)
    .bind(email)
    .bind(handle)
    .fetch_one(&mut *conn)
    .await?;
    if duplicate {
        return Ok(Err(MembershipLifecycleError::BanExists));
    }
    let row = sqlx::query(
        "INSERT INTO workspace_ban (workspace_id, email_norm, handle_norm, created_by, reason) \
         VALUES ($1, $2, $3, $4, $5) \
         RETURNING id, email_norm, handle_norm, created_by, reason, \
                   (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms",
    )
    .bind(workspace_id)
    .bind(email)
    .bind(handle)
    .bind(created_by)
    .bind(reason)
    .fetch_one(&mut *conn)
    .await?;
    Ok(Ok(decode_ban(&row)?))
}

fn decode_ban(row: &sqlx::postgres::PgRow) -> Result<BanRecord, sqlx::Error> {
    Ok(BanRecord {
        id: row.try_get("id")?,
        email: row.try_get("email_norm")?,
        handle: row.try_get("handle_norm")?,
        created_by: row.try_get("created_by")?,
        reason: row.try_get("reason")?,
        created_at_ms: row.try_get("created_at_ms")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_role_immutable_sentence_is_closed() {
        assert_eq!(
            MembershipLifecycleError::AgentRoleImmutable.as_swift_message(),
            "agent roles are fixed to member"
        );
    }
}
