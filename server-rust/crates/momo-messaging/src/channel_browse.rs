//! ADR-0224 D3·D4·D8·D9·D11 — the public-channel browse list and self-join.
//!
//! **One judgment, two halves** (D11). "May this person open this public channel?" is
//!
//!   * the **person** half — an active human whose workspace role is not `guest`
//!     ([`judge_browse_person`]; the route has already refused a non-human bearer with
//!     `require_human`), judged **before** any channel is read, so the answer to a
//!     refused person never depends on which channel id they named; and
//!   * the **channel** half — public, not archived, `browse_listed` on
//!     ([`channel_open_to_people_sql!`] / [`CHANNEL_OPEN_TO_PEOPLE_SQL`]), a named SQL
//!     piece that every statement here embeds once, inside the statement that reads or
//!     writes. There is no pre-check beside the write that a later edit could leave behind.
//!
//! Row-level security bounds the workspace only; the channel boundary is this piece. A
//! private channel, a DM, a public channel with `browse_listed` off and an archived
//! channel are therefore all absent from the list and all the same "not found" to the
//! join, whoever asks (owners and admins included) and whether or not the caller already
//! sits in that channel.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::identity::WorkspaceRole;
use crate::read_state::update_read_cursor_in_tx;

/// The channel half of the D11 judgment — public, not archived, shown in browse — over the
/// channel row `alias`. The three conditions are written once, in
/// [`momo_auth::channel_open_to_people_sql`] (ADR-0224 D13 shares them with the agent-side
/// rules); this is that function's answer, ready to sit in a `format!` (it is `Display`).
///
/// `kind = 'public'` is also implied by the table check `channel_browse_listed_public_ck`
/// (migration 184); it stays in the piece so the boundary does not rest on a constraint alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelOpenToPeople(pub &'static str);

impl std::fmt::Display for ChannelOpenToPeople {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&momo_auth::channel_open_to_people_sql(self.0))
    }
}

/// [`ChannelOpenToPeople`] over the row alias `$alias` (a string literal).
#[macro_export]
macro_rules! channel_open_to_people_sql {
    ($alias:literal) => {
        $crate::channel_browse::ChannelOpenToPeople($alias)
    };
}

/// [`channel_open_to_people_sql!`] over the alias `c`.
pub const CHANNEL_OPEN_TO_PEOPLE_SQL: ChannelOpenToPeople = channel_open_to_people_sql!("c");

/// Why the person half refused. Each maps onto the refusal the rest of the API already
/// gives for that standing (403).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowsePersonRefusal {
    /// No active workspace membership: not in the workspace, suspended or removed.
    NotActive,
    /// Workspace role `guest` (ADR-0219 I-6): invited channels only.
    Guest,
}

/// The person half of the D11 judgment, from the caller's active workspace role
/// ([`crate::active_workspace_role`]). A human bearer is assumed: the routes refuse
/// every other credential before they get here.
pub fn judge_browse_person(
    role: Option<WorkspaceRole>,
) -> Result<WorkspaceRole, BrowsePersonRefusal> {
    match role {
        None => Err(BrowsePersonRefusal::NotActive),
        Some(WorkspaceRole::Guest) => Err(BrowsePersonRefusal::Guest),
        Some(role) => Ok(role),
    }
}

/// Default page size of the browse list.
pub const BROWSE_LIMIT_DEFAULT: i64 = 100;
/// Largest page size of the browse list.
pub const BROWSE_LIMIT_MAX: i64 = 200;

/// Clamp a requested page size into `1..=BROWSE_LIMIT_MAX`; absent or unusable falls back
/// to the default (the channel list's lenient rule).
pub fn clamp_browse_limit(requested: Option<i64>) -> i64 {
    match requested {
        Some(value) if value > 0 => value.min(BROWSE_LIMIT_MAX),
        _ => BROWSE_LIMIT_DEFAULT,
    }
}

/// Where the next page starts: strictly after this `(lower(name), id)`. Taken from the
/// last row the previous page returned, so it only ever carries what the caller saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowseAfter {
    pub sort_name: String,
    pub id: Uuid,
}

/// One row of the browse list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowsableChannel {
    pub id: Uuid,
    pub name: String,
    pub topic: Option<String>,
    /// Live memberships of active, not-deleted members — people and agents together, the
    /// count the channel header shows.
    pub member_count: i64,
    /// The caller has a live membership in it.
    pub is_member: bool,
    pub is_default: bool,
    /// The sort key, for the next page's [`BrowseAfter`].
    pub sort_name: String,
}

/// The browse list (D3): every channel open to people in the workspace, ordered by
/// `lower(name)` then id, optionally narrowed to those whose name or topic contains
/// `filter` (case-insensitive, matched as plain text — `%` and `_` are characters,
/// not patterns). Returns at most `limit` rows.
pub async fn list_browsable_channels_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    viewer_member_id: Uuid,
    filter: Option<&str>,
    after: Option<&BrowseAfter>,
    limit: i64,
) -> Result<Vec<BrowsableChannel>, DbError> {
    let sql = format!(
        "SELECT c.id, \
                COALESCE(c.name, '') AS name, \
                c.topic, \
                c.is_default, \
                lower(COALESCE(c.name, '')) AS sort_name, \
                ( SELECT count(*) \
                    FROM membership x \
                    JOIN member m \
                      ON m.workspace_id = x.workspace_id AND m.id = x.member_id \
                   WHERE x.workspace_id = c.workspace_id \
                     AND x.channel_id = c.id \
                     AND x.left_at IS NULL \
                     AND m.deleted_at IS NULL \
                     AND m.status = 'active' \
                )::bigint AS member_count, \
                EXISTS ( \
                  SELECT 1 FROM membership me \
                   WHERE me.workspace_id = c.workspace_id \
                     AND me.channel_id = c.id \
                     AND me.member_id = $2 \
                     AND me.left_at IS NULL \
                ) AS is_member \
           FROM channel c \
          WHERE c.workspace_id = $1 \
            AND {open} \
            AND ($3::text IS NULL \
                 OR strpos(lower(COALESCE(c.name, '')), lower($3::text)) > 0 \
                 OR strpos(lower(COALESCE(c.topic, '')), lower($3::text)) > 0) \
            AND ($4::text IS NULL \
                 OR (lower(COALESCE(c.name, '')), c.id) > ($4::text, $5::uuid)) \
          ORDER BY lower(COALESCE(c.name, '')), c.id \
          LIMIT $6",
        open = CHANNEL_OPEN_TO_PEOPLE_SQL,
    );
    let rows = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(viewer_member_id)
        .bind(filter)
        .bind(after.map(|a| a.sort_name.as_str()))
        .bind(after.map(|a| a.id))
        .bind(limit)
        .fetch_all(&mut *conn)
        .await?;
    rows.iter()
        .map(|row| {
            Ok(BrowsableChannel {
                id: row.try_get("id")?,
                name: row.try_get("name")?,
                topic: row.try_get("topic")?,
                member_count: row.try_get("member_count")?,
                is_member: row.try_get("is_member")?,
                is_default: row.try_get("is_default")?,
                sort_name: row.try_get("sort_name")?,
            })
        })
        .collect::<Result<_, sqlx::Error>>()
        .map_err(DbError::from)
}

/// What a self-join did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfJoin {
    /// The id is not a channel open to people in this workspace (private, DM, browse off,
    /// archived, unknown, another workspace's) — one answer for all of them.
    NotFound,
    /// The caller now has a live membership. `admitted` is true when this call made it
    /// live (a new row, or a left row brought back); false when it already was, in which
    /// case nothing was written. `rejoined` is true when `admitted` brought back a row the
    /// caller had left.
    Member {
        membership_id: Uuid,
        admitted: bool,
        rejoined: bool,
    },
}

/// Self-join (D4·D9): put the caller into a channel open to people.
///
/// * A new row gets channel role `member`. A row the caller had left is brought back as
///   `member` — whatever channel role it carried before (an old `owner` included).
/// * A live row is not touched: role, `joined_at` and the read position stay as they are.
///   (Not the add-member write, which overwrites a live member's role.)
/// * Only when this call admitted the caller does the read position move to the channel's
///   end, in the same transaction and after the membership exists (the cursor write needs
///   a live row), so the channel starts with no unread messages.
pub async fn self_join_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
) -> Result<SelfJoin, DbError> {
    let sql = format!(
        "WITH target AS ( \
           SELECT c.id FROM channel c \
            WHERE c.workspace_id = $1 \
              AND c.id = $2 \
              AND {open} \
         ), \
         prior AS ( \
           SELECT id, left_at IS NULL AS live \
             FROM membership \
            WHERE workspace_id = $1 \
              AND channel_id IN (SELECT id FROM target) \
              AND member_id = $3 \
         ), \
         admitted AS ( \
           INSERT INTO membership (workspace_id, channel_id, member_id, role) \
           SELECT $1, t.id, $3, 'member'::membership_role \
             FROM target t \
           ON CONFLICT (channel_id, member_id) DO UPDATE \
              SET left_at = NULL, \
                  role = EXCLUDED.role \
            WHERE membership.left_at IS NOT NULL \
           RETURNING id \
         ) \
         SELECT EXISTS (SELECT 1 FROM target) AS found, \
                COALESCE((SELECT id FROM admitted), (SELECT id FROM prior)) AS membership_id, \
                EXISTS (SELECT 1 FROM admitted) AS admitted, \
                EXISTS (SELECT 1 FROM prior WHERE NOT live) AS was_left",
        open = CHANNEL_OPEN_TO_PEOPLE_SQL,
    );
    let row = sqlx::query(&sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .fetch_one(&mut *conn)
        .await?;
    let found: bool = row.try_get("found").map_err(DbError::from)?;
    if !found {
        return Ok(SelfJoin::NotFound);
    }
    let membership_id: Option<Uuid> = row.try_get("membership_id").map_err(DbError::from)?;
    let admitted: bool = row.try_get("admitted").map_err(DbError::from)?;
    let was_left: bool = row.try_get("was_left").map_err(DbError::from)?;
    let membership_id = match membership_id {
        Some(id) => id,
        None => {
            // The same person's other join won the row while this statement waited on the
            // unique index: the row is live now, but this statement's snapshot saw none of
            // it and the guarded upsert (rightly) did not touch it. Read it again; this call
            // admitted no one, so it writes nothing.
            let live: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM membership \
                  WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3 \
                    AND left_at IS NULL",
            )
            .bind(workspace_id)
            .bind(channel_id)
            .bind(member_id)
            .fetch_optional(&mut *conn)
            .await?;
            match live {
                Some(id) => {
                    return Ok(SelfJoin::Member {
                        membership_id: id,
                        admitted: false,
                        rejoined: false,
                    })
                }
                None => {
                    return Err(DbError::from(sqlx::Error::Protocol(
                        "self-join found the channel but no membership row".into(),
                    )))
                }
            }
        }
    };
    if admitted {
        update_read_cursor_in_tx(conn, workspace_id, channel_id, member_id, i64::MAX).await?;
    }
    Ok(SelfJoin::Member {
        membership_id,
        admitted,
        rejoined: admitted && was_left,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One place: the piece is momo-auth's judgment, not a second copy of it.
    #[test]
    fn the_channel_piece_is_the_one_people_judgment_in_momo_auth() {
        assert_eq!(
            CHANNEL_OPEN_TO_PEOPLE_SQL.to_string(),
            momo_auth::channel_open_to_people_sql("c")
        );
        assert_eq!(
            channel_open_to_people_sql!("ch").to_string(),
            momo_auth::channel_open_to_people_sql("ch")
        );
    }

    #[test]
    fn the_person_half_admits_owner_admin_and_member_only() {
        for role in [
            WorkspaceRole::Owner,
            WorkspaceRole::Admin,
            WorkspaceRole::Member,
        ] {
            assert_eq!(judge_browse_person(Some(role)), Ok(role));
        }
        assert_eq!(
            judge_browse_person(Some(WorkspaceRole::Guest)),
            Err(BrowsePersonRefusal::Guest)
        );
        assert_eq!(
            judge_browse_person(None),
            Err(BrowsePersonRefusal::NotActive)
        );
    }

    #[test]
    fn the_browse_limit_falls_back_rather_than_rejecting() {
        assert_eq!(clamp_browse_limit(None), BROWSE_LIMIT_DEFAULT);
        assert_eq!(clamp_browse_limit(Some(0)), BROWSE_LIMIT_DEFAULT);
        assert_eq!(clamp_browse_limit(Some(-3)), BROWSE_LIMIT_DEFAULT);
        assert_eq!(clamp_browse_limit(Some(7)), 7);
        assert_eq!(clamp_browse_limit(Some(10_000)), BROWSE_LIMIT_MAX);
    }
}
