//! `work_tier_policy` — the ADR-0125 D11 policy ledger (migration 025).
//!
//! Port of Swift `Routes/WorkTierPolicyRoutes.swift`, whose SQL this module now
//! owns.
//!
//! Two scopes share one table and one shape:
//!
//! * the **workspace default** is the `member_id IS NULL` row (owner/admin only),
//! * a **member override** is the `member_id = <me>` row (any active human, for
//!   itself only).
//!
//! `inherited: true` is the load-bearing half of the read: it means no member row
//! exists and the workspace default is what is actually in force, so the panel
//! says that instead of implying a saved override the member never made.

use momo_db::DbError;
use sqlx::PgConnection;
use uuid::Uuid;

/// Which row a request addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierScope {
    Workspace,
    Member(Uuid),
}

impl TierScope {
    pub fn member_id(self) -> Option<Uuid> {
        match self {
            TierScope::Workspace => None,
            TierScope::Member(member_id) => Some(member_id),
        }
    }

    /// The audit `detail.scope` label (Swift :156).
    pub fn as_str(self) -> &'static str {
        match self {
            TierScope::Workspace => "workspace",
            TierScope::Member(_) => "member",
        }
    }
}

/// The projected policy row (Swift `WorkTierPolicyDTO`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TierPolicy {
    pub member_id: Option<Uuid>,
    pub mode: String,
    pub auto_target: Option<String>,
    pub inherited: bool,
    pub updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TierSpecInvalid {
    #[error("mode must be t1_only, ask, or auto")]
    Mode,
    #[error("autoTarget is allowed only in auto mode")]
    AutoTargetOutsideAutoMode,
    #[error("auto mode requires autoTarget")]
    AutoTargetMissing,
    #[error("autoTarget must be a work host id or cloud")]
    AutoTargetShape,
}

/// Why a syntactically valid `autoTarget` still cannot be stored. All three are
/// **409**s in Swift, not 400s: the value is well-formed, the registry just does
/// not offer it to this scope right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TierTargetRejected {
    #[error("auto target work host is unavailable")]
    Unavailable,
    #[error("workspace policy requires a workspace-scoped host")]
    NotWorkspaceScoped,
    #[error("member policy target belongs to another member")]
    OtherMembersHost,
}

/// Swift `validatedMode` (:186-191). Migration 025's CHECK set, exactly.
pub fn validated_tier_mode(raw: &str) -> Result<&'static str, TierSpecInvalid> {
    match raw {
        "t1_only" => Ok("t1_only"),
        "ask" => Ok("ask"),
        "auto" => Ok("auto"),
        _ => Err(TierSpecInvalid::Mode),
    }
}

/// Swift `validatedAutoTarget` (:193-208).
///
/// The cross-field rule is the point: `autoTarget` outside `auto` mode is a 400
/// rather than a silently dropped field, because a client that sent one believes
/// it is in force.
pub fn validated_auto_target(
    raw: Option<&str>,
    mode: &str,
) -> Result<Option<String>, TierSpecInvalid> {
    if mode != "auto" {
        return match raw {
            None => Ok(None),
            Some(_) => Err(TierSpecInvalid::AutoTargetOutsideAutoMode),
        };
    }
    let raw = raw.ok_or(TierSpecInvalid::AutoTargetMissing)?;
    let value = raw.trim().to_ascii_lowercase();
    if value == "cloud" || Uuid::parse_str(&value).is_ok() {
        Ok(Some(value))
    } else {
        Err(TierSpecInvalid::AutoTargetShape)
    }
}

/// A `work_tier_policy` read: member (NULL for the workspace default), mode,
/// auto target, `updated_at` in ms, and whether the row came from the default
/// branch of the member query.
type TierPolicyRow = (Option<Uuid>, String, Option<String>, i64, bool);

/// The same row without the `inherited` flag — an upsert always writes the scope
/// it was asked for, so there is nothing to inherit.
type TierPolicyWriteRow = (Option<Uuid>, String, Option<String>, i64);

/// Read the policy in force for a scope (Swift `loadPolicy` :247-312).
///
/// The member arm is a two-branch `UNION ALL` ordered by priority rather than a
/// `COALESCE`: the override and the default are different rows with different
/// timestamps, and the answer has to say **which one** it returned. A missing
/// pair falls back to the compiled default `ask` — `inherited` true for a member
/// (the workspace default is what applies), false for the workspace itself.
pub async fn load_tier_policy(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    scope: TierScope,
) -> Result<TierPolicy, DbError> {
    let row: Option<TierPolicyRow> = match scope {
        TierScope::Workspace => {
            sqlx::query_as(
                "SELECT member_id, mode, auto_target, \
                        floor(extract(epoch from updated_at) * 1000)::bigint, \
                        false AS inherited \
                   FROM work_tier_policy \
                  WHERE workspace_id = $1 \
                    AND member_id IS NULL \
                  LIMIT 1",
            )
            .bind(workspace_id)
            .fetch_optional(&mut *conn)
            .await?
        }
        TierScope::Member(member_id) => {
            sqlx::query_as(
                "SELECT member_id, mode, auto_target, updated_at_ms, inherited \
                   FROM ( \
                     SELECT member_id, mode, auto_target, \
                            floor(extract(epoch from updated_at) * 1000)::bigint AS updated_at_ms, \
                            false AS inherited, 0 AS priority \
                       FROM work_tier_policy \
                      WHERE workspace_id = $1 AND member_id = $2 \
                     UNION ALL \
                     SELECT $2, mode, auto_target, \
                            floor(extract(epoch from updated_at) * 1000)::bigint AS updated_at_ms, \
                            true AS inherited, 1 AS priority \
                       FROM work_tier_policy \
                      WHERE workspace_id = $1 AND member_id IS NULL \
                   ) p \
                  ORDER BY priority \
                  LIMIT 1",
            )
            .bind(workspace_id)
            .bind(member_id)
            .fetch_optional(&mut *conn)
            .await?
        }
    };

    Ok(match row {
        Some((member_id, mode, auto_target, updated_at_ms, inherited)) => TierPolicy {
            member_id,
            mode,
            auto_target,
            inherited,
            updated_at_ms: Some(updated_at_ms),
        },
        None => TierPolicy {
            member_id: scope.member_id(),
            mode: "ask".to_string(),
            auto_target: None,
            inherited: scope.member_id().is_some(),
            updated_at_ms: None,
        },
    })
}

/// Upsert one scope's row (Swift :120-147).
///
/// The two partial unique indexes (migration 025) mean the conflict target
/// differs per scope, which is why this is two statements and not one with a
/// nullable key: `ON CONFLICT (workspace_id, member_id)` would never fire for the
/// default row, since `NULL` is not equal to `NULL`.
pub async fn upsert_tier_policy(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    scope: TierScope,
    mode: &str,
    auto_target: Option<&str>,
) -> Result<TierPolicy, DbError> {
    let (member_id, mode, auto_target, updated_at_ms): TierPolicyWriteRow = match scope {
        TierScope::Member(member_id) => {
            sqlx::query_as(
                "INSERT INTO work_tier_policy (workspace_id, member_id, mode, auto_target) \
                     VALUES ($1, $2, $3, $4) \
                     ON CONFLICT (workspace_id, member_id) WHERE member_id IS NOT NULL \
                     DO UPDATE SET mode = EXCLUDED.mode, \
                                   auto_target = EXCLUDED.auto_target, \
                                   updated_at = clock_timestamp() \
                     RETURNING member_id, mode, auto_target, \
                               floor(extract(epoch from updated_at) * 1000)::bigint",
            )
            .bind(workspace_id)
            .bind(member_id)
            .bind(mode)
            .bind(auto_target)
            .fetch_one(&mut *conn)
            .await?
        }
        TierScope::Workspace => {
            sqlx::query_as(
                "INSERT INTO work_tier_policy (workspace_id, member_id, mode, auto_target) \
                     VALUES ($1, NULL, $2, $3) \
                     ON CONFLICT (workspace_id) WHERE member_id IS NULL \
                     DO UPDATE SET mode = EXCLUDED.mode, \
                                   auto_target = EXCLUDED.auto_target, \
                                   updated_at = clock_timestamp() \
                     RETURNING member_id, mode, auto_target, \
                               floor(extract(epoch from updated_at) * 1000)::bigint",
            )
            .bind(workspace_id)
            .bind(mode)
            .bind(auto_target)
            .fetch_one(&mut *conn)
            .await?
        }
    };

    Ok(TierPolicy {
        member_id,
        mode,
        auto_target,
        // A row that was just written is by definition not inherited.
        inherited: false,
        updated_at_ms: Some(updated_at_ms),
    })
}

/// Is this `autoTarget` a host the scope may actually point at?
/// (Swift `requireAllowedTarget` :210-245.)
///
/// `cloud` is a reserved selector with no registry row, so it short-circuits.
/// A concrete host id is checked `FOR SHARE` inside the caller's transaction —
/// the lock is what stops a host being revoked between the check and the write.
pub async fn tier_target_allowed(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    scope: TierScope,
    auto_target: Option<&str>,
) -> Result<Result<(), TierTargetRejected>, DbError> {
    let Some(target) = auto_target else {
        return Ok(Ok(()));
    };
    if target == "cloud" {
        return Ok(Ok(()));
    }
    let Ok(host_id) = Uuid::parse_str(target) else {
        return Ok(Ok(()));
    };

    let row: Option<(String, Uuid)> = sqlx::query_as(
        "SELECT scope, owner_member_id \
           FROM work_host \
          WHERE id = $1 \
            AND workspace_id = $2 \
            AND revoked_at IS NULL \
          FOR SHARE",
    )
    .bind(host_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;

    let Some((host_scope, owner_member_id)) = row else {
        return Ok(Err(TierTargetRejected::Unavailable));
    };
    Ok(match scope {
        TierScope::Workspace if host_scope != "workspace" => {
            Err(TierTargetRejected::NotWorkspaceScoped)
        }
        TierScope::Member(member_id)
            if host_scope != "workspace" && owner_member_id != member_id =>
        {
            Err(TierTargetRejected::OtherMembersHost)
        }
        _ => Ok(()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_set_is_migration_025s_check_set() {
        for mode in ["t1_only", "ask", "auto"] {
            assert_eq!(validated_tier_mode(mode).expect("known"), mode);
        }
        assert_eq!(validated_tier_mode("Auto"), Err(TierSpecInvalid::Mode));
        assert_eq!(validated_tier_mode("t3_only"), Err(TierSpecInvalid::Mode));
    }

    /// The cross-field rule: a target sent outside auto mode is refused, not
    /// dropped — the client that sent it believes it is in force.
    #[test]
    fn auto_target_is_only_legal_in_auto_mode_and_is_required_there() {
        assert_eq!(validated_auto_target(None, "ask"), Ok(None));
        assert_eq!(
            validated_auto_target(Some("cloud"), "ask"),
            Err(TierSpecInvalid::AutoTargetOutsideAutoMode)
        );
        assert_eq!(
            validated_auto_target(None, "auto"),
            Err(TierSpecInvalid::AutoTargetMissing)
        );
        assert_eq!(
            validated_auto_target(Some("  CLOUD "), "auto"),
            Ok(Some("cloud".to_string()))
        );
        let host = Uuid::from_u128(9);
        assert_eq!(
            validated_auto_target(Some(&host.to_string().to_uppercase()), "auto"),
            Ok(Some(host.to_string())),
            "migration 025's CHECK regex only matches the lower-cased spelling"
        );
        assert_eq!(
            validated_auto_target(Some("my-laptop"), "auto"),
            Err(TierSpecInvalid::AutoTargetShape)
        );
    }

    #[test]
    fn the_scope_label_is_the_audit_label() {
        assert_eq!(TierScope::Workspace.as_str(), "workspace");
        assert_eq!(TierScope::Member(Uuid::from_u128(1)).as_str(), "member");
        assert_eq!(TierScope::Workspace.member_id(), None);
    }
}
