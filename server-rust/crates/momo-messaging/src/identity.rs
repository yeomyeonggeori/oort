//! Identity (minimal) — the member/workspace/membership lookups the write path
//! and a route layer need, nothing more.
//!
//! **Invariant #5 (agent = member).** Humans and agents are the *same* `member`
//! table; [`MemberKind`] is the only discriminator (`member.kind`, a
//! `member_kind` enum — `001_init.sql:11,48`). There is no separate bot table and
//! no separate lookup path: an agent author resolves through [`get_member`] and
//! sends through the identical write path as a human (see [`crate::message`]).
//! Special-casing agents anywhere here would break that invariant.
//!
//! Every query in this module runs on a connection whose `app.workspace_id` GUC
//! was set by [`momo_db::with_tenant_tx`]; the RLS `ws_isolation` policy
//! (`001_init.sql:395`) therefore scopes each read to the caller's workspace
//! (invariant #6) without this code passing `workspace_id` as a filter.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

/// `member_kind` enum (`001_init.sql:11`). Humans and agents share one table;
/// this is the sole discriminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberKind {
    Human,
    Agent,
}

impl MemberKind {
    /// The `text` label matching the `member_kind` Postgres enum.
    pub fn as_db_label(self) -> &'static str {
        match self {
            MemberKind::Human => "human",
            MemberKind::Agent => "agent",
        }
    }

    /// Parse the `member_kind` label back to the enum.
    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "human" => Some(MemberKind::Human),
            "agent" => Some(MemberKind::Agent),
            _ => None,
        }
    }
}

/// A principal in a workspace — human or agent, symmetric (`member`,
/// `001_init.sql:45`). Only the columns the messaging spine needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: MemberKind,
    pub status: String,
    pub display_name: String,
    pub handle: String,
}

/// A workspace (tenant root, `001_init.sql:28`). Minimal projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
}

fn decode_member(row: &sqlx::postgres::PgRow) -> Result<Member, sqlx::Error> {
    let kind_label: String = row.try_get("kind")?;
    let kind = MemberKind::from_db_label(&kind_label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown member_kind '{kind_label}'").into()))?;
    Ok(Member {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        kind,
        status: row.try_get("status")?,
        display_name: row.try_get("display_name")?,
        handle: row.try_get("handle")?,
    })
}

/// Look up one member by id, workspace-scoped by the ambient RLS GUC. `None` if
/// the member does not exist in the caller's workspace (or is filtered by RLS).
pub async fn get_member(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<Option<Member>, DbError> {
    let row = sqlx::query(
        "SELECT id, workspace_id, kind::text AS kind, status::text AS status, \
                display_name, handle \
           FROM member \
          WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(decode_member(&row)?)),
        None => Ok(None),
    }
}

/// Look up the caller's workspace by id (RLS-scoped). `None` if absent/soft-deleted.
pub async fn get_workspace(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<Option<Workspace>, DbError> {
    let row = sqlx::query(
        "SELECT id, slug, name FROM workspace \
          WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(Workspace {
            id: row.try_get("id")?,
            slug: row.try_get("slug")?,
            name: row.try_get("name")?,
        })),
        None => Ok(None),
    }
}

/// Whether `member_id` is a current (not-left) member of `channel_id`
/// (`membership`, `001_init.sql:122`). The route layer uses this to authorize a
/// send; the write path itself stays a pure spine.
pub async fn is_channel_member(
    conn: &mut PgConnection,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM membership \
            WHERE channel_id = $1 AND member_id = $2 AND left_at IS NULL)",
    )
    .bind(channel_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(exists)
}

/// Outcome of [`verify_password_login`] — the three states Swift
/// `AuthRoutes.LoginResolution` distinguishes, kept distinct because they map to
/// different HTTP codes (401 vs 403).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordLogin {
    /// Credentials verified and the member is `active`.
    Active(Member),
    /// Credentials verified but the member is `suspended` → 403, not 401.
    Suspended,
    /// Unknown email, wrong password, or a non-active/non-suspended status.
    /// Deliberately one bucket so the response cannot enumerate accounts.
    Invalid,
}

/// Resolve a human member by email and verify the submitted password.
///
/// Ports Swift `AuthRoutes.login`'s resolution query (`AuthRoutes.swift:61-83`)
/// exactly, including where the password check happens: **inside Postgres**, via
/// the `momo_password_verify(raw, stored_hash)` pgcrypto helper added by
/// `005_auth_password_hash.sql`. Keeping the algorithm in the DB is what makes
/// the Rust and Swift servers accept the same bcrypt hashes without porting a
/// crypto stack — and the function is `STABLE`/NULL-safe, so an SSO-only human
/// (`password_hash IS NULL`) simply fails to verify.
///
/// The connection must already carry the tenant GUC (open it with
/// [`momo_db::with_tenant_tx`]); the RLS policies then scope the lookup to the
/// workspace being logged into. Neither the raw password nor the stored hash is
/// ever returned or logged by this function.
pub async fn verify_password_login(
    conn: &mut PgConnection,
    email: &str,
    password: &str,
) -> Result<PasswordLogin, DbError> {
    if password.is_empty() {
        // Swift rejects an empty password before touching the DB.
        return Ok(PasswordLogin::Invalid);
    }
    let row = sqlx::query(
        "SELECT m.id, m.workspace_id, m.kind::text AS kind, m.status::text AS status, \
                m.display_name, m.handle, \
                momo_password_verify($1, h.password_hash) AS password_ok \
           FROM human h \
           JOIN member m ON m.id = h.member_id \
          WHERE h.email = $2",
    )
    .bind(password)
    .bind(email)
    .fetch_optional(&mut *conn)
    .await?;

    let Some(row) = row else {
        return Ok(PasswordLogin::Invalid);
    };
    let password_ok: Option<bool> = row.try_get("password_ok")?;
    if password_ok != Some(true) {
        return Ok(PasswordLogin::Invalid);
    }
    let member = decode_member(&row)?;
    match member.status.as_str() {
        "suspended" => Ok(PasswordLogin::Suspended),
        "active" => Ok(PasswordLogin::Active(member)),
        _ => Ok(PasswordLogin::Invalid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_kind_labels_round_trip() {
        for kind in [MemberKind::Human, MemberKind::Agent] {
            assert_eq!(MemberKind::from_db_label(kind.as_db_label()), Some(kind));
        }
        assert_eq!(MemberKind::from_db_label("robot"), None);
    }
}
