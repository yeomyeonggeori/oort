//! Channel (minimal) — creation and lookup, plus the `channel_seq` counter row
//! that the message write path row-locks for its per-channel sequence.
//!
//! [`create_channel`] ports the Swift `ChannelRoutes.create` CTE
//! (`ChannelRoutes.swift:89-151`): one statement inserts the `channel`, seeds its
//! `channel_seq` row at `last_seq = 0`, and adds the creator as an `owner`
//! membership — all in the same tenant transaction, so a half-created channel
//! can never exist. The `channel_seq` seed is load-bearing: [`crate::message`]'s
//! gapless-seq spine `UPDATE … RETURNING`s that row, and a channel without it
//! could not accept messages.
//!
//! DM channels (which need a `dm_key`) are out of scope for B1 — this covers the
//! public/private channels the messaging spine exercises.

use momo_db::{with_tenant_tx, DbError, PgPool};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::error::MessagingError;

/// `channel_kind` enum (`001_init.sql:13`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Public,
    Private,
    Dm,
}

impl ChannelKind {
    pub fn as_db_label(self) -> &'static str {
        match self {
            ChannelKind::Public => "public",
            ChannelKind::Private => "private",
            ChannelKind::Dm => "dm",
        }
    }

    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "public" => Some(ChannelKind::Public),
            "private" => Some(ChannelKind::Private),
            "dm" => Some(ChannelKind::Dm),
            _ => None,
        }
    }
}

/// A channel (`001_init.sql:93`). Minimal projection for the spine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Channel {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: ChannelKind,
    pub name: Option<String>,
    pub topic: Option<String>,
}

/// Input for [`create_channel`] — a public or private channel.
#[derive(Debug, Clone)]
pub struct NewChannel {
    pub kind: ChannelKind,
    pub name: String,
    pub topic: Option<String>,
    /// The member creating the channel; recorded as `created_by` and seeded as
    /// the channel's `owner` membership.
    pub created_by: Uuid,
}

fn decode_channel(row: &sqlx::postgres::PgRow) -> Result<Channel, sqlx::Error> {
    let kind_label: String = row.try_get("kind")?;
    let kind = ChannelKind::from_db_label(&kind_label).ok_or_else(|| {
        sqlx::Error::Decode(format!("unknown channel_kind '{kind_label}'").into())
    })?;
    Ok(Channel {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        kind,
        name: row.try_get("name")?,
        topic: row.try_get("topic")?,
    })
}

/// Create a public/private channel + its `channel_seq` row + the creator's
/// `owner` membership, atomically on `conn` (composable inside a larger tenant
/// transaction). Returns `Ok(None)` if the `channel_name_uniq` guard rejects the
/// name (a non-archived channel with the same name already exists).
pub async fn create_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    spec: &NewChannel,
) -> Result<Option<Channel>, DbError> {
    let row = sqlx::query(
        "WITH inserted_channel AS ( \
           INSERT INTO channel (workspace_id, kind, name, topic, created_by) \
           SELECT $1, $2::channel_kind, $3, $4, $5 \
            WHERE NOT EXISTS ( \
                  SELECT 1 FROM channel existing \
                   WHERE existing.workspace_id = $1 \
                     AND existing.kind <> 'dm' \
                     AND existing.archived_at IS NULL \
                     AND lower(existing.name) = lower($3)) \
           RETURNING id, workspace_id, kind, name, topic \
         ), \
         inserted_seq AS ( \
           INSERT INTO channel_seq (channel_id, workspace_id, last_seq) \
           SELECT id, workspace_id, 0 FROM inserted_channel \
           RETURNING channel_id \
         ), \
         inserted_membership AS ( \
           INSERT INTO membership (workspace_id, channel_id, member_id, role) \
           SELECT workspace_id, id, $5, 'owner'::membership_role FROM inserted_channel \
           RETURNING channel_id \
         ) \
         SELECT c.id, c.workspace_id, c.kind::text AS kind, c.name, c.topic \
           FROM inserted_channel c \
           JOIN inserted_seq s ON s.channel_id = c.id \
           JOIN inserted_membership m ON m.channel_id = c.id",
    )
    .bind(workspace_id)
    .bind(spec.kind.as_db_label())
    .bind(&spec.name)
    .bind(&spec.topic)
    .bind(spec.created_by)
    .fetch_optional(&mut *conn)
    .await?;

    match row {
        Some(row) => Ok(Some(decode_channel(&row)?)),
        None => Ok(None),
    }
}

/// Pool-level [`create_channel_in_tx`] wrapped in the tenant transaction.
/// Errors with [`MessagingError::ChannelNameConflict`] on a name collision.
pub async fn create_channel(
    pool: &PgPool,
    workspace_id: Uuid,
    spec: NewChannel,
) -> Result<Channel, MessagingError> {
    let created = with_tenant_tx(pool, workspace_id, move |conn| {
        Box::pin(async move { create_channel_in_tx(conn, workspace_id, &spec).await })
    })
    .await?;
    created.ok_or(MessagingError::ChannelNameConflict)
}

/// Look up one channel by id (RLS-scoped). `None` if absent in the caller's workspace.
pub async fn get_channel(
    conn: &mut PgConnection,
    channel_id: Uuid,
) -> Result<Option<Channel>, DbError> {
    let row = sqlx::query(
        "SELECT id, workspace_id, kind::text AS kind, name, topic \
           FROM channel WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_optional(&mut *conn)
    .await?;
    match row {
        Some(row) => Ok(Some(decode_channel(&row)?)),
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// the workspace channel list (B4 — Swift `ChannelRoutes.fetchChannels` :401-460)
// ---------------------------------------------------------------------------

/// Swift `ChannelRoutes.validatedLimit` bounds (`ChannelRoutes.swift`): default
/// 200, hard ceiling 500.
pub const CHANNEL_LIST_LIMIT_DEFAULT: i64 = 200;
pub const CHANNEL_LIST_LIMIT_MAX: i64 = 500;

/// Clamp a requested page size into `1..=CHANNEL_LIST_LIMIT_MAX`, falling back to
/// the default for anything absent or unparseable (Swift `Int($0) ?? 200`).
pub fn clamp_channel_list_limit(requested: Option<i64>) -> i64 {
    match requested {
        Some(value) if value > 0 => value.min(CHANNEL_LIST_LIMIT_MAX),
        _ => CHANNEL_LIST_LIMIT_DEFAULT,
    }
}

/// One row of `GET /v1/workspaces/{ws}/channels` — every channel the CALLER is
/// a current member of, DMs included.
///
/// Two fields are about the caller rather than the channel and must stay that
/// way: `muted` is this member's `notification_pref` row (ADR-0124 — muting is
/// per-member, never channel-wide), and `member_ids` is populated **only for
/// DMs**, matching Swift, because a DM's identity is its pair while a public
/// channel's roster is a separate read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelSummary {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub kind: ChannelKind,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub dm_key: Option<String>,
    /// Active participants — DMs only; empty for public/private channels.
    pub member_ids: Vec<Uuid>,
    pub created_by: Option<Uuid>,
    /// Milliseconds since the epoch, or `None` for a live channel.
    pub archived_at_ms: Option<i64>,
    /// The CALLING member's push-suppression preference for this channel.
    pub muted: bool,
}

fn decode_channel_summary(row: &sqlx::postgres::PgRow) -> Result<ChannelSummary, sqlx::Error> {
    let kind_label: String = row.try_get("kind")?;
    let kind = ChannelKind::from_db_label(&kind_label).ok_or_else(|| {
        sqlx::Error::Decode(format!("unknown channel_kind '{kind_label}'").into())
    })?;
    Ok(ChannelSummary {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        kind,
        name: row.try_get("name")?,
        topic: row.try_get("topic")?,
        dm_key: row.try_get("dm_key")?,
        member_ids: row.try_get("member_ids")?,
        created_by: row.try_get("created_by")?,
        archived_at_ms: row.try_get("archived_at_ms")?,
        muted: row.try_get("muted")?,
    })
}

/// Every channel `member_id` currently belongs to in `workspace_id`, ordered the
/// way Swift orders them: public, then private, then DM, each group by
/// case-folded name.
///
/// The `JOIN membership` is the access control, not a filter: there is no branch
/// here that could return a channel the caller has left, and RLS scopes the
/// whole statement to the tenant on top of that. Archived channels are excluded
/// unless asked for, because the sidebar's default question is "where can I
/// talk", not "what has ever existed".
pub async fn list_workspace_channels(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    include_archived: bool,
    limit: i64,
) -> Result<Vec<ChannelSummary>, DbError> {
    let rows = sqlx::query(
        "SELECT c.id, \
                c.workspace_id, \
                c.kind::text AS kind, \
                c.name, \
                c.topic, \
                c.dm_key, \
                c.created_by, \
                CASE WHEN c.archived_at IS NULL THEN NULL \
                     ELSE floor(extract(epoch from c.archived_at) * 1000)::bigint \
                END AS archived_at_ms, \
                CASE WHEN c.kind = 'dm' THEN COALESCE(( \
                       SELECT array_agg(participant.member_id ORDER BY participant.member_id::text) \
                         FROM membership participant \
                        WHERE participant.channel_id = c.id \
                          AND participant.left_at IS NULL \
                     ), '{}'::uuid[]) \
                     ELSE '{}'::uuid[] \
                END AS member_ids, \
                EXISTS ( \
                  SELECT 1 FROM notification_pref np \
                   WHERE np.workspace_id = c.workspace_id \
                     AND np.channel_id = c.id \
                     AND np.member_id = $2 \
                     AND (np.muted_until IS NULL OR np.muted_until > now()) \
                ) AS muted \
           FROM channel c \
           JOIN membership actor_membership \
             ON actor_membership.channel_id = c.id \
            AND actor_membership.member_id = $2 \
            AND actor_membership.left_at IS NULL \
          WHERE c.workspace_id = $1 \
            AND ($3 OR c.archived_at IS NULL) \
          ORDER BY CASE c.kind::text \
                     WHEN 'public' THEN 0 \
                     WHEN 'private' THEN 1 \
                     ELSE 2 \
                   END, \
                   lower(COALESCE(c.name, '')), \
                   c.id \
          LIMIT $4",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(include_archived)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_channel_summary)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_channel_list_limit_is_clamped_not_trusted() {
        assert_eq!(clamp_channel_list_limit(None), CHANNEL_LIST_LIMIT_DEFAULT);
        assert_eq!(
            clamp_channel_list_limit(Some(0)),
            CHANNEL_LIST_LIMIT_DEFAULT
        );
        assert_eq!(
            clamp_channel_list_limit(Some(-4)),
            CHANNEL_LIST_LIMIT_DEFAULT
        );
        assert_eq!(clamp_channel_list_limit(Some(12)), 12);
        assert_eq!(
            clamp_channel_list_limit(Some(10_000)),
            CHANNEL_LIST_LIMIT_MAX,
            "a client cannot ask for an unbounded page"
        );
    }

    #[test]
    fn channel_kind_labels_round_trip() {
        for kind in [ChannelKind::Public, ChannelKind::Private, ChannelKind::Dm] {
            assert_eq!(ChannelKind::from_db_label(kind.as_db_label()), Some(kind));
        }
        assert_eq!(ChannelKind::from_db_label("broadcast"), None);
    }
}
