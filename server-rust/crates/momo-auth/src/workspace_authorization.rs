//! The workspace-role authority — `workspace_membership` + active-member guard.
//!
//! Port of Swift `Auth/WorkspaceAuthorization.swift:6-114`, added in B2.2
//! because every route this batch mounts asks the same question ("is this
//! principal an active member, and is it an admin?") and Swift answers it in
//! exactly one place: *"The single workspace-role authority. Channel roles never
//! imply workspace authority after ADR-0128; all callers share this query and
//! active-member guard."*
//!
//! It lives in `momo-auth` for the same reason the Swift file lives under
//! `Auth/`: this is authorization, not messaging or T3. Keeping it single-owner
//! is the point — a second copy of the membership predicate is how a route ends
//! up authorizing on a channel role.
//!
//! Takes a caller-supplied `&mut PgConnection` (the RLS GUC seam stays in
//! `momo_db::with_tenant_tx`, invariant #6).

use sqlx::PgConnection;
use uuid::Uuid;

/// `workspace_membership.role` (Swift `WorkspaceRole`, :6-28).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceRole {
    Owner,
    Admin,
    Member,
    Guest,
}

impl WorkspaceRole {
    pub fn as_db_label(self) -> &'static str {
        match self {
            WorkspaceRole::Owner => "owner",
            WorkspaceRole::Admin => "admin",
            WorkspaceRole::Member => "member",
            WorkspaceRole::Guest => "guest",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        Some(match label {
            "owner" => WorkspaceRole::Owner,
            "admin" => WorkspaceRole::Admin,
            "member" => WorkspaceRole::Member,
            "guest" => WorkspaceRole::Guest,
            _ => return None,
        })
    }

    /// Swift `isAdmin` (:21): owner OR admin — nothing else, ever.
    pub fn is_admin(self) -> bool {
        matches!(self, WorkspaceRole::Owner | WorkspaceRole::Admin)
    }

    /// Swift `WorkspaceRole.rank` (:12-18). Lower is higher privilege.
    pub fn rank(self) -> i32 {
        match self {
            Self::Owner => 0,
            Self::Admin => 1,
            Self::Member => 2,
            Self::Guest => 3,
        }
    }

    /// Swift `WorkspaceRole.parse` (:23-28): trim, lowercase, closed vocabulary.
    pub fn parse(raw: &str) -> Option<Self> {
        Self::from_db_label(raw.trim().to_ascii_lowercase().as_str())
    }

    /// Target is strictly below the actor (Swift `requireCanManage` rank guard).
    pub fn can_manage_target(self, target: Self) -> bool {
        target.rank() > self.rank()
    }

    /// ADR-0128 D2 workspace/channel role change, actor vs current target role.
    /// Self is refused by the caller. Admin/owner only; equal-or-higher is no.
    pub fn can_change_role_of(self, target: Self) -> bool {
        self.is_admin() && self.can_manage_target(target)
    }

    /// Swift `requireCanManage` requested-role arm: admin cannot grant admin/owner.
    /// Owner may appoint any role, including owner.
    pub fn can_grant_role(self, requested: Self) -> bool {
        match self {
            Self::Owner => true,
            Self::Admin => requested.rank() > Self::Admin.rank(),
            Self::Member | Self::Guest => false,
        }
    }

    /// Suspend/reinstate ladder — same hierarchy as `requireCanManage` without
    /// a requested role. Self is refused by the caller.
    pub fn can_suspend(self, target: Self) -> bool {
        self.is_admin() && self.can_manage_target(target)
    }

    /// Remove ladder — same as [`can_suspend`].
    pub fn can_remove(self, target: Self) -> bool {
        self.is_admin() && self.can_manage_target(target)
    }

    /// Ban ledger is workspace-admin only; there is no target member.
    pub fn can_ban(self) -> bool {
        self.is_admin()
    }

    /// ADR-0128 D2 for operator password reset. Self is refused by the
    /// caller; this is only the actor/target ladder. Owner may reset another
    /// owner (the multi-owner unlock path). Admin may reset member/guest only.
    pub fn can_issue_password_reset_for(self, target: Self) -> bool {
        match self {
            Self::Owner => true,
            Self::Admin => matches!(target, Self::Member | Self::Guest),
            Self::Member | Self::Guest => false,
        }
    }
}

/// The active workspace role of a member, or `None` when there is no active
/// membership (Swift `activeRole` :34-77, the non-`forUpdate` arm).
///
/// The `member.status = 'active' AND member.deleted_at IS NULL` join is not
/// decoration: a suspended or soft-deleted member keeps its `workspace_membership`
/// row, so dropping the join would authorize a member the workspace has removed.
pub async fn active_workspace_role(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<WorkspaceRole>, sqlx::Error> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT wm.role::text \
           FROM workspace_membership wm \
           JOIN member m \
             ON m.workspace_id = wm.workspace_id \
            AND m.id = wm.member_id \
          WHERE wm.workspace_id = $1 \
            AND wm.member_id = $2 \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          LIMIT 1",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(role.as_deref().and_then(WorkspaceRole::from_db_label))
}

/// Swift `activeRole` `forUpdate` arm (:42-57). Same predicate as
/// [`active_workspace_role`], locked so a concurrent suspend/remove cannot
/// authorize on a role that is about to disappear.
pub async fn active_workspace_role_for_update(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<WorkspaceRole>, sqlx::Error> {
    let role: Option<String> = sqlx::query_scalar(
        "SELECT wm.role::text \
           FROM workspace_membership wm \
           JOIN member m \
             ON m.workspace_id = wm.workspace_id \
            AND m.id = wm.member_id \
          WHERE wm.workspace_id = $1 \
            AND wm.member_id = $2 \
            AND m.status = 'active' \
            AND m.deleted_at IS NULL \
          LIMIT 1 \
          FOR UPDATE OF wm, m",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(role.as_deref().and_then(WorkspaceRole::from_db_label))
}

/// Whether a member's `human` profile carries a **verified** email matching one
/// of the instance-operator allow-list entries (Swift
/// `CloudCreditRoutes.requireCreditWriter` :162-189).
///
/// Returns the verified email lowercased, or `None`. The comparison itself is
/// the caller's (it holds the allow-list), but the `email_verified = true`
/// predicate is here so no caller can forget it.
pub async fn verified_operator_email(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<String>, sqlx::Error> {
    let email: Option<String> = sqlx::query_scalar(
        "SELECT lower(email) FROM human \
          WHERE member_id = $1 AND workspace_id = $2 AND email_verified = true",
    )
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_owner_and_admin_are_admins() {
        assert!(WorkspaceRole::Owner.is_admin());
        assert!(WorkspaceRole::Admin.is_admin());
        assert!(!WorkspaceRole::Member.is_admin());
        assert!(!WorkspaceRole::Guest.is_admin());
    }

    #[test]
    fn roles_round_trip_the_db_vocabulary() {
        for label in ["owner", "admin", "member", "guest"] {
            let role = WorkspaceRole::from_db_label(label).expect("known role");
            assert_eq!(role.as_db_label(), label);
        }
        assert!(WorkspaceRole::from_db_label("platform_admin").is_none());
    }

    #[test]
    fn password_reset_ladder_matches_adr_0128_d2() {
        use WorkspaceRole::{Admin, Guest, Member, Owner};
        assert!(Owner.can_issue_password_reset_for(Owner));
        assert!(Owner.can_issue_password_reset_for(Admin));
        assert!(Owner.can_issue_password_reset_for(Member));
        assert!(Owner.can_issue_password_reset_for(Guest));
        assert!(!Admin.can_issue_password_reset_for(Owner));
        assert!(!Admin.can_issue_password_reset_for(Admin));
        assert!(Admin.can_issue_password_reset_for(Member));
        assert!(Admin.can_issue_password_reset_for(Guest));
        assert!(!Member.can_issue_password_reset_for(Owner));
        assert!(!Member.can_issue_password_reset_for(Admin));
        assert!(!Member.can_issue_password_reset_for(Member));
        assert!(!Member.can_issue_password_reset_for(Guest));
        assert!(!Guest.can_issue_password_reset_for(Owner));
        assert!(!Guest.can_issue_password_reset_for(Member));
        assert!(!Guest.can_issue_password_reset_for(Guest));
    }

    #[test]
    fn lifecycle_ladders_match_swift_require_can_manage() {
        use WorkspaceRole::{Admin, Guest, Member, Owner};
        assert!(Owner.can_change_role_of(Admin));
        assert!(Owner.can_change_role_of(Member));
        assert!(Owner.can_change_role_of(Guest));
        assert!(!Owner.can_change_role_of(Owner));
        assert!(!Admin.can_change_role_of(Owner));
        assert!(!Admin.can_change_role_of(Admin));
        assert!(Admin.can_change_role_of(Member));
        assert!(Admin.can_change_role_of(Guest));
        assert!(!Member.can_change_role_of(Guest));
        assert!(!Guest.can_change_role_of(Guest));

        assert!(Owner.can_grant_role(Owner));
        assert!(Owner.can_grant_role(Admin));
        assert!(Admin.can_grant_role(Member));
        assert!(Admin.can_grant_role(Guest));
        assert!(!Admin.can_grant_role(Admin));
        assert!(!Admin.can_grant_role(Owner));
        assert!(!Member.can_grant_role(Guest));

        assert!(Owner.can_suspend(Admin));
        assert!(!Owner.can_suspend(Owner));
        assert!(Admin.can_remove(Member));
        assert!(!Admin.can_remove(Admin));
        assert!(Owner.can_ban());
        assert!(Admin.can_ban());
        assert!(!Member.can_ban());
        assert!(!Guest.can_ban());
    }

    #[test]
    fn parse_accepts_the_closed_vocabulary_after_trim() {
        assert_eq!(WorkspaceRole::parse(" Owner "), Some(WorkspaceRole::Owner));
        assert_eq!(WorkspaceRole::parse("ADMIN"), Some(WorkspaceRole::Admin));
        assert!(WorkspaceRole::parse("platform_admin").is_none());
        assert!(WorkspaceRole::parse("").is_none());
    }
}
