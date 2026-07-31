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

/// A `membership` row as the channel write endpoints return it (Swift
/// `ChannelMembershipDTO`, `DTOs.swift:543-556`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelMembership {
    pub id: Uuid,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub member_id: Uuid,
    /// `membership_role` label (`owner` for a creator).
    pub role: String,
    pub joined_at_ms: i64,
    pub left_at_ms: Option<i64>,
}

/// What `POST /v1/workspaces/{ws}/channels` returns (Swift
/// `CreateChannelResponse`): the channel **and** the creator's membership, so a
/// client knows it is already inside without a second read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedChannel {
    pub channel: ChannelSummary,
    pub creator_membership: ChannelMembership,
}

fn decode_channel_membership(
    row: &sqlx::postgres::PgRow,
) -> Result<ChannelMembership, sqlx::Error> {
    Ok(ChannelMembership {
        id: row.try_get("membership_id")?,
        workspace_id: row.try_get("workspace_id")?,
        channel_id: row.try_get("id")?,
        member_id: row.try_get("member_id")?,
        role: row.try_get("membership_role")?,
        joined_at_ms: row.try_get("joined_at_ms")?,
        left_at_ms: row.try_get("left_at_ms")?,
    })
}

/// Create a public/private channel + its `channel_seq` row + the creator's
/// `owner` membership, atomically on `conn` (composable inside a larger tenant
/// transaction). Returns `Ok(None)` if the `channel_name_uniq` guard rejects the
/// name (a non-archived channel with the same name already exists).
///
/// The three inserts are one statement on purpose. A channel without its
/// `channel_seq` row cannot accept a message (the send spine `UPDATE …
/// RETURNING`s it), and a channel without its creator's membership is one
/// nobody can read — either half-state would be a channel that exists and does
/// not work.
pub async fn create_channel_detailed_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    spec: &NewChannel,
) -> Result<Option<CreatedChannel>, DbError> {
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
           RETURNING id, workspace_id, kind, name, topic, dm_key, created_by, archived_at \
         ), \
         inserted_seq AS ( \
           INSERT INTO channel_seq (channel_id, workspace_id, last_seq) \
           SELECT id, workspace_id, 0 FROM inserted_channel \
           RETURNING channel_id \
         ), \
         inserted_membership AS ( \
           INSERT INTO membership (workspace_id, channel_id, member_id, role) \
           SELECT workspace_id, id, $5, 'owner'::membership_role FROM inserted_channel \
           RETURNING id, channel_id, member_id, role, joined_at, left_at \
         ) \
         SELECT c.id, \
                c.workspace_id, \
                c.kind::text AS kind, \
                c.name, \
                c.topic, \
                c.dm_key, \
                c.created_by, \
                CASE WHEN c.archived_at IS NULL THEN NULL \
                     ELSE floor(extract(epoch from c.archived_at) * 1000)::bigint \
                END AS archived_at_ms, \
                m.id AS membership_id, \
                m.member_id, \
                m.role::text AS membership_role, \
                floor(extract(epoch from m.joined_at) * 1000)::bigint AS joined_at_ms, \
                CASE WHEN m.left_at IS NULL THEN NULL \
                     ELSE floor(extract(epoch from m.left_at) * 1000)::bigint \
                END AS left_at_ms \
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

    let Some(row) = row else { return Ok(None) };
    let kind_label: String = row.try_get("kind").map_err(DbError::from)?;
    let kind = ChannelKind::from_db_label(&kind_label).ok_or_else(|| {
        DbError::from(sqlx::Error::Decode(
            format!("unknown channel_kind '{kind_label}'").into(),
        ))
    })?;
    let channel = ChannelSummary {
        id: row.try_get("id").map_err(DbError::from)?,
        workspace_id: row.try_get("workspace_id").map_err(DbError::from)?,
        kind,
        name: row.try_get("name").map_err(DbError::from)?,
        topic: row.try_get("topic").map_err(DbError::from)?,
        dm_key: row.try_get("dm_key").map_err(DbError::from)?,
        // A brand-new channel has exactly one member and is not a DM, and Swift
        // hardcodes `'memberIds', '[]'` here for the same reason the list does:
        // a non-DM channel's roster is a separate read.
        member_ids: Vec::new(),
        created_by: row.try_get("created_by").map_err(DbError::from)?,
        archived_at_ms: row.try_get("archived_at_ms").map_err(DbError::from)?,
        // Nobody can have muted a channel that did not exist a statement ago.
        muted: false,
    };
    let creator_membership = decode_channel_membership(&row).map_err(DbError::from)?;
    Ok(Some(CreatedChannel {
        channel,
        creator_membership,
    }))
}

/// [`create_channel_detailed_in_tx`] narrowed to the spine's minimal projection.
/// Kept so every B1 caller (and its tests) keeps the shape it was written
/// against; the SQL lives in exactly one place.
pub async fn create_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    spec: &NewChannel,
) -> Result<Option<Channel>, DbError> {
    Ok(create_channel_detailed_in_tx(conn, workspace_id, spec)
        .await?
        .map(|created| Channel {
            id: created.channel.id,
            workspace_id: created.channel.workspace_id,
            kind: created.channel.kind,
            name: created.channel.name,
            topic: created.channel.topic,
        }))
}

// ---------------------------------------------------------------------------
// channel spec validation (B4.1 — Swift `ChannelRoutes.normalized*`, :391-424)
// ---------------------------------------------------------------------------

/// Swift `normalizedChannelName` bounds, counted in characters.
pub const CHANNEL_NAME_MAX_CHARS: usize = 80;
/// Swift `normalizedTopic` bound.
pub const CHANNEL_TOPIC_MAX_CHARS: usize = 280;

/// Why a channel spec was refused. Each variant carries Swift's exact sentence,
/// because these strings reach a person typing a channel name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ChannelSpecInvalid {
    #[error("channel kind must be public or private")]
    Kind,
    #[error("channel name must be 1-80 characters")]
    NameLength,
    #[error("channel name must use lowercase letters, numbers, hyphen, or underscore")]
    NameCharset,
    #[error("channel topic must be 280 characters or fewer")]
    TopicLength,
}

/// `public` | `private`, trimmed and lowercased. **`dm` is not creatable here**:
/// a DM's identity is its canonical participant pair, which `POST …/dms` derives
/// — minting one through this path would produce a DM with no `dm_key` and
/// therefore no idempotency.
pub fn normalize_channel_kind(raw: &str) -> Result<ChannelKind, ChannelSpecInvalid> {
    match raw.trim().to_lowercase().as_str() {
        "public" => Ok(ChannelKind::Public),
        "private" => Ok(ChannelKind::Private),
        _ => Err(ChannelSpecInvalid::Kind),
    }
}

/// Swift's `^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$` after trim + lowercase,
/// spelled out rather than pulled through a regex dependency.
///
/// Length is checked **before** the charset, matching Swift, so an 81-character
/// valid-looking name is told it is too long rather than told it has bad
/// characters.
pub fn normalize_channel_name(raw: &str) -> Result<String, ChannelSpecInvalid> {
    let value = raw.trim().to_lowercase();
    let length = value.chars().count();
    if length == 0 || length > CHANNEL_NAME_MAX_CHARS {
        return Err(ChannelSpecInvalid::NameLength);
    }
    let is_edge = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let is_inner = |c: char| is_edge(c) || c == '_' || c == '-';
    let mut chars = value.chars();
    let first = chars.next().expect("non-empty");
    if !is_edge(first) {
        return Err(ChannelSpecInvalid::NameCharset);
    }
    let last = value.chars().next_back().expect("non-empty");
    if !is_edge(last) {
        return Err(ChannelSpecInvalid::NameCharset);
    }
    if !value.chars().all(is_inner) {
        return Err(ChannelSpecInvalid::NameCharset);
    }
    Ok(value)
}

/// Trim a topic; an empty one is `None`, not `Some("")` — Swift reads a blank
/// topic as "no topic" rather than storing an empty string.
pub fn normalize_channel_topic(raw: Option<&str>) -> Result<Option<String>, ChannelSpecInvalid> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > CHANNEL_TOPIC_MAX_CHARS {
        return Err(ChannelSpecInvalid::TopicLength);
    }
    Ok(Some(value.to_string()))
}

// ---------------------------------------------------------------------------
// notification preference (B4.1 — Swift `ChannelRoutes.updateNotificationPref`)
// ---------------------------------------------------------------------------

/// The write half of the `muted` flag every channel-list row already carries
/// (ADR-0124). Returns `false` when the caller has no active membership in a
/// live channel — the route turns that into Swift's 403.
///
/// v0 stores an indefinite mute as `muted_until = NULL` and un-mutes by
/// **deleting** the row, which is why `muted` reads as `EXISTS(...)` rather than
/// a boolean column: absence is the default, so a member who never touched the
/// setting owns no row at all.
pub async fn set_notification_pref_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    muted: bool,
) -> Result<bool, DbError> {
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 \
             FROM membership ms \
             JOIN channel c \
               ON c.id = ms.channel_id AND c.workspace_id = ms.workspace_id \
            WHERE ms.workspace_id = $1 \
              AND ms.channel_id = $2 \
              AND ms.member_id = $3 \
              AND ms.left_at IS NULL \
              AND c.archived_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(channel_id)
    .bind(member_id)
    .fetch_one(&mut *conn)
    .await?;
    if !allowed {
        return Ok(false);
    }

    if muted {
        sqlx::query(
            "INSERT INTO notification_pref \
               (workspace_id, member_id, channel_id, muted_until) \
             VALUES ($1, $3, $2, NULL) \
             ON CONFLICT (workspace_id, member_id, channel_id) \
             DO UPDATE SET muted_until = NULL, updated_at = now()",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "DELETE FROM notification_pref \
              WHERE workspace_id = $1 AND channel_id = $2 AND member_id = $3",
        )
        .bind(workspace_id)
        .bind(channel_id)
        .bind(member_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(true)
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

    /// A DM created through the channel endpoint would have no `dm_key`, and a
    /// DM without a `dm_key` is a pair that can be opened twice.
    #[test]
    fn a_dm_cannot_be_minted_through_the_channel_creation_path() {
        assert_eq!(normalize_channel_kind("public"), Ok(ChannelKind::Public));
        assert_eq!(
            normalize_channel_kind(" Private "),
            Ok(ChannelKind::Private)
        );
        assert_eq!(normalize_channel_kind("dm"), Err(ChannelSpecInvalid::Kind));
        assert_eq!(
            normalize_channel_kind("").unwrap_err().to_string(),
            "channel kind must be public or private"
        );
    }

    #[test]
    fn channel_names_follow_the_swift_charset_and_edges() {
        assert_eq!(normalize_channel_name("  General  "), Ok("general".into()));
        assert_eq!(normalize_channel_name("a"), Ok("a".into()));
        assert_eq!(normalize_channel_name("9"), Ok("9".into()));
        assert_eq!(
            normalize_channel_name("eng-team_2"),
            Ok("eng-team_2".into())
        );

        // Edges must be alphanumeric; the middle may carry - and _.
        for rejected in ["-lead", "lead-", "_x", "x_", "-", "_"] {
            assert_eq!(
                normalize_channel_name(rejected),
                Err(ChannelSpecInvalid::NameCharset),
                "{rejected} must be refused"
            );
        }
        assert_eq!(
            normalize_channel_name("도그푸딩"),
            Err(ChannelSpecInvalid::NameCharset),
            "the charset is ASCII; a non-ASCII name is refused by name, not silently mangled"
        );
        assert_eq!(
            normalize_channel_name("a b"),
            Err(ChannelSpecInvalid::NameCharset)
        );

        // Length is answered before the charset, so an over-long name is told
        // the true reason.
        assert_eq!(
            normalize_channel_name("   "),
            Err(ChannelSpecInvalid::NameLength)
        );
        let too_long = "a".repeat(CHANNEL_NAME_MAX_CHARS + 1);
        assert_eq!(
            normalize_channel_name(&too_long),
            Err(ChannelSpecInvalid::NameLength)
        );
        assert!(normalize_channel_name(&"a".repeat(CHANNEL_NAME_MAX_CHARS)).is_ok());
    }

    #[test]
    fn a_blank_topic_is_absent_rather_than_empty() {
        assert_eq!(normalize_channel_topic(None), Ok(None));
        assert_eq!(normalize_channel_topic(Some("   ")), Ok(None));
        assert_eq!(
            normalize_channel_topic(Some("  도그푸딩 1차  ")),
            Ok(Some("도그푸딩 1차".into()))
        );
        assert_eq!(
            normalize_channel_topic(Some(&"긴".repeat(CHANNEL_TOPIC_MAX_CHARS + 1))),
            Err(ChannelSpecInvalid::TopicLength),
            "the bound is characters, not bytes"
        );
        assert!(normalize_channel_topic(Some(&"긴".repeat(CHANNEL_TOPIC_MAX_CHARS))).is_ok());
    }
}
