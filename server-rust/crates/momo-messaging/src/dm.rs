//! Direct messages — idempotent 1:1 channel opening and discovery (B1.2).
//!
//! Ports Swift `DMRoutes.swift` (:60-237 open, :249-306 list). A DM is an
//! ordinary `channel` row with `kind='dm'` and a `dm_key`; the messaging spine
//! ([`crate::message`]) then serves it unchanged — there is no second write path
//! for direct messages, which is why this module adds *only* opening and
//! listing.
//!
//! ## What makes "one channel per pair" true
//!
//! Three things, in the order they run, and each is load-bearing:
//!
//! 1. **Canonical key.** [`canonical_participants`] sorts the two member ids, so
//!    (A,B) and (B,A) hash to the same `dm_key`
//!    (`encode(digest(key,'sha256'),'hex')`, computed in Postgres exactly like
//!    Swift so a channel opened by either server is found by the other).
//! 2. **`pg_advisory_xact_lock`** on `workspace:pair` — serializes only this
//!    pair before the INSERT takes its snapshot, so an `ON CONFLICT` loser can
//!    *see* the winner's committed row instead of returning zero rows.
//! 3. **The partial unique index** `channel_dm_uniq (workspace_id, dm_key) WHERE
//!    kind='dm'` (`001_init.sql:114-116`) — the data authority. The lock is an
//!    optimization for the read-back; the index is what makes a duplicate
//!    impossible even if the lock were removed.
//!
//! The whole open is one statement inside one tenant transaction: channel +
//! `channel_seq` seed + both memberships, or nothing. A half-created DM (a
//! channel with no `channel_seq` row) could never accept a message, so the final
//! `SELECT` refuses to return a row unless every part landed.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::channel::ChannelKind;

/// The maximum DM list page Swift serves (`DMRoutes.swift:300`).
pub const DM_LIST_LIMIT: i64 = 500;

/// A direct-message channel as the DM surface projects it (Swift `ChannelDTO`
/// built by `DMRoutes`).
///
/// `archived_at` is deliberately absent: Swift emits `archivedAtMs: NULL` on
/// both DM routes because `list` filters `archived_at IS NULL` and `open`
/// un-archives before returning. Carrying a field that is always null would
/// invite a caller to believe it means something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectMessage {
    pub id: Uuid,
    pub workspace_id: Uuid,
    /// Always [`ChannelKind::Dm`]; kept so the DTO can render `kind` from the
    /// row rather than from an assumption.
    pub kind: ChannelKind,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub dm_key: String,
    /// Active participants. On `open` this is the canonical pair; on `list` it
    /// is every member whose `membership.left_at IS NULL`.
    pub member_ids: Vec<Uuid>,
    pub created_by: Option<Uuid>,
    /// The **calling** member's push-suppression preference for this channel
    /// (`notification_pref`, migration 018) — not a channel-wide flag.
    pub muted: bool,
}

/// Outcome of [`open_direct_message_in_tx`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenedDirectMessage {
    /// The target id is not an active, non-deleted member of this workspace
    /// (Swift 404 `active workspace member not found`).
    TargetNotFound,
    /// The pair's channel, and whether *this* call created it. Swift answers
    /// 201 when `created`, 200 otherwise.
    Opened {
        channel: DirectMessage,
        created: bool,
    },
}

/// Why [`validate_direct_message_target`] refused before any DB access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DirectMessageTargetInvalid {
    /// Swift `DMRoutes.validateTargetMember` (:243-247) — 400.
    #[error("direct message target must be another member")]
    SelfTarget,
}

/// A member may not open a DM with itself (Swift `validateTargetMember`).
pub fn validate_direct_message_target(
    actor_id: Uuid,
    target_id: Uuid,
) -> Result<(), DirectMessageTargetInvalid> {
    if actor_id == target_id {
        return Err(DirectMessageTargetInvalid::SelfTarget);
    }
    Ok(())
}

/// The two participants in canonical order — the ordering that makes (A,B) and
/// (B,A) the same DM.
///
/// Swift sorts by `uuidString.lowercased()`; `Uuid::to_string()` is already the
/// lowercase hyphenated form, and because that rendering is the 16 bytes in
/// order as hex with hyphens at fixed positions, string order and byte order
/// agree. Sorting the strings anyway keeps the parity argument literal.
pub fn canonical_participants(first: Uuid, second: Uuid) -> [Uuid; 2] {
    let mut pair = [first, second];
    pair.sort_by_key(|id| id.to_string());
    pair
}

/// The pre-hash participant key: canonical ids joined by `:`, lowercased
/// (Swift `DMRoutes.swift:68`). Hashed to `dm_key` **in Postgres**, so both
/// servers derive the same key from the same pair.
pub fn dm_participant_key(participants: [Uuid; 2]) -> String {
    format!("{}:{}", participants[0], participants[1]).to_lowercase()
}

/// The advisory-lock key for one workspace/pair (Swift `DMRoutes.swift:103`).
pub fn dm_lock_key(workspace_id: Uuid, participant_key: &str) -> String {
    format!(
        "{}:{}",
        workspace_id.to_string().to_lowercase(),
        participant_key
    )
}

fn decode_direct_message(row: &sqlx::postgres::PgRow) -> Result<DirectMessage, sqlx::Error> {
    let kind_label: String = row.try_get("kind")?;
    let kind = ChannelKind::from_db_label(&kind_label).ok_or_else(|| {
        sqlx::Error::Decode(format!("unknown channel_kind '{kind_label}'").into())
    })?;
    Ok(DirectMessage {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        kind,
        name: row.try_get("name")?,
        topic: row.try_get("topic")?,
        dm_key: row.try_get("dm_key")?,
        member_ids: row.try_get("member_ids")?,
        created_by: row.try_get("created_by")?,
        muted: row.try_get("muted")?,
    })
}

/// Open (or find) the 1:1 DM between `actor_member_id` and `target_member_id`.
///
/// Idempotent by construction: calling it twice — in either argument order, from
/// either server, concurrently — yields one channel. The second call reports
/// `created: false`.
///
/// Runs on a caller-supplied connection so the membership authorization and this
/// write share one tenant transaction, matching Swift's
/// `withTenantTransaction` block.
pub async fn open_direct_message_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    actor_member_id: Uuid,
    target_member_id: Uuid,
) -> Result<OpenedDirectMessage, DbError> {
    let target_active: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
           SELECT 1 FROM member m \
            WHERE m.id = $1 \
              AND m.workspace_id = $2 \
              AND m.status = 'active' \
              AND m.deleted_at IS NULL)",
    )
    .bind(target_member_id)
    .bind(workspace_id)
    .fetch_one(&mut *conn)
    .await?;
    if !target_active {
        return Ok(OpenedDirectMessage::TargetNotFound);
    }

    let participants = canonical_participants(actor_member_id, target_member_id);
    let participant_key = dm_participant_key(participants);
    let lock_key = dm_lock_key(workspace_id, &participant_key);

    // Serialize only this workspace/pair before the INSERT below takes its
    // snapshot, so an ON CONFLICT loser can read the winner's committed channel.
    // The partial unique index remains the data authority.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))")
        .bind(&lock_key)
        .execute(&mut *conn)
        .await?;

    let row = sqlx::query(
        "WITH requested AS ( \
           SELECT encode(digest($2::text, 'sha256'), 'hex') AS dm_key \
         ), \
         inserted_channel AS ( \
           INSERT INTO channel (id, workspace_id, kind, name, topic, dm_key, created_by) \
           SELECT uuidv7(), $1, 'dm'::channel_kind, NULL, NULL, requested.dm_key, $3 \
             FROM requested \
           ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm' \
           DO NOTHING \
           RETURNING channel.*, true AS created \
         ), \
         selected_channel AS ( \
           SELECT inserted_channel.* FROM inserted_channel \
           UNION ALL \
           SELECT existing.*, false AS created \
             FROM channel existing \
             JOIN requested ON requested.dm_key = existing.dm_key \
            WHERE existing.workspace_id = $1 \
              AND existing.kind = 'dm' \
              AND NOT EXISTS (SELECT 1 FROM inserted_channel) \
           LIMIT 1 \
         ), \
         reopened_channel AS ( \
           UPDATE channel reopened \
              SET archived_at = NULL, updated_at = now() \
             FROM selected_channel \
            WHERE reopened.id = selected_channel.id \
              AND reopened.archived_at IS NOT NULL \
           RETURNING reopened.id \
         ), \
         ensured_seq AS ( \
           INSERT INTO channel_seq (channel_id, workspace_id, last_seq) \
           SELECT id, workspace_id, 0 FROM selected_channel \
           ON CONFLICT (channel_id) DO NOTHING \
           RETURNING channel_id \
         ), \
         upserted_memberships AS ( \
           INSERT INTO membership (workspace_id, channel_id, member_id, role) \
           SELECT selected_channel.workspace_id, selected_channel.id, \
                  participant.member_id, 'member'::membership_role \
             FROM selected_channel \
             CROSS JOIN LATERAL unnest(ARRAY[$4, $5]::uuid[]) AS participant(member_id) \
           ON CONFLICT (channel_id, member_id) DO UPDATE SET left_at = NULL \
           RETURNING channel_id \
         ) \
         SELECT selected_channel.id, \
                selected_channel.workspace_id, \
                selected_channel.kind::text AS kind, \
                selected_channel.name, \
                selected_channel.topic, \
                selected_channel.dm_key, \
                selected_channel.created_by, \
                selected_channel.created, \
                ARRAY[$4, $5]::uuid[] AS member_ids, \
                EXISTS ( \
                  SELECT 1 FROM notification_pref np \
                   WHERE np.workspace_id = selected_channel.workspace_id \
                     AND np.channel_id = selected_channel.id \
                     AND np.member_id = $3 \
                     AND (np.muted_until IS NULL OR np.muted_until > now()) \
                ) AS muted \
           FROM selected_channel \
          WHERE ( \
                  EXISTS (SELECT 1 FROM channel_seq seq WHERE seq.channel_id = selected_channel.id) \
                  OR EXISTS (SELECT 1 FROM ensured_seq \
                              WHERE ensured_seq.channel_id = selected_channel.id) \
                ) \
            AND ( \
                  selected_channel.archived_at IS NULL \
                  OR EXISTS (SELECT 1 FROM reopened_channel \
                              WHERE reopened_channel.id = selected_channel.id) \
                ) \
            AND ( \
                  SELECT count(*) FROM upserted_memberships \
                   WHERE upserted_memberships.channel_id = selected_channel.id \
                ) = 2",
    )
    .bind(workspace_id)
    .bind(&participant_key)
    .bind(actor_member_id)
    .bind(participants[0])
    .bind(participants[1])
    .fetch_optional(&mut *conn)
    .await?;

    // Swift throws a 500 here: every guard in the WHERE clause is something the
    // same statement just made true, so a missing row means the invariant broke
    // rather than that the caller asked for something impossible.
    let row = row.ok_or_else(|| DbError::from(sqlx::Error::RowNotFound))?;
    let created: bool = row.try_get("created").map_err(DbError::from)?;
    Ok(OpenedDirectMessage::Opened {
        channel: decode_direct_message(&row).map_err(DbError::from)?,
        created,
    })
}

/// The caller's live DM channels, newest first (Swift `fetchDirectMessages`).
///
/// Archived DMs are omitted; `member_ids` lists the participants who have not
/// left. Capped at [`DM_LIST_LIMIT`] like Swift.
pub async fn list_direct_messages(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Vec<DirectMessage>, DbError> {
    let rows = sqlx::query(
        "SELECT c.id, \
                c.workspace_id, \
                c.kind::text AS kind, \
                c.name, \
                c.topic, \
                c.dm_key, \
                c.created_by, \
                COALESCE(( \
                  SELECT array_agg(participant.member_id ORDER BY participant.member_id::text) \
                    FROM membership participant \
                   WHERE participant.channel_id = c.id \
                     AND participant.left_at IS NULL \
                ), '{}'::uuid[]) AS member_ids, \
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
            AND c.kind = 'dm' \
            AND c.archived_at IS NULL \
          ORDER BY c.created_at DESC, c.id \
          LIMIT $3",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(DM_LIST_LIMIT)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(decode_direct_message)
        .collect::<Result<_, _>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The property the whole DM surface rests on: argument order must not
    /// change the key. Remove the sort and this goes red.
    #[test]
    fn the_pair_key_is_order_independent() {
        let a = Uuid::from_u128(0xaaaa_0000_0000_0000_0000_0000_0000_0001);
        let b = Uuid::from_u128(0xbbbb_0000_0000_0000_0000_0000_0000_0002);
        assert_eq!(
            dm_participant_key(canonical_participants(a, b)),
            dm_participant_key(canonical_participants(b, a)),
        );
        assert_eq!(canonical_participants(b, a), [a, b]);
    }

    /// Swift lowercases the joined key before hashing; an uppercase rendering
    /// would hash to a different `dm_key` and silently fork the pair's channel
    /// between the Swift and Rust servers.
    #[test]
    fn the_pair_key_is_lowercase_ids_joined_by_colon() {
        let a = Uuid::from_u128(1);
        let b = Uuid::from_u128(2);
        let pair = canonical_participants(a, b);
        let key = dm_participant_key(pair);
        assert_eq!(key, format!("{a}:{b}"));
        assert_eq!(key, key.to_lowercase());
        assert!(key.contains(':'));
    }

    #[test]
    fn the_lock_key_namespaces_the_pair_by_workspace() {
        let ws = Uuid::from_u128(9);
        let other_ws = Uuid::from_u128(10);
        let pair = canonical_participants(Uuid::from_u128(1), Uuid::from_u128(2));
        let key = dm_participant_key(pair);
        assert_ne!(
            dm_lock_key(ws, &key),
            dm_lock_key(other_ws, &key),
            "two tenants opening the same member-id pair must not serialize on one lock"
        );
        assert!(dm_lock_key(ws, &key).starts_with(&ws.to_string()));
    }

    #[test]
    fn a_member_cannot_dm_itself() {
        let member = Uuid::from_u128(3);
        assert_eq!(
            validate_direct_message_target(member, member),
            Err(DirectMessageTargetInvalid::SelfTarget)
        );
        assert!(validate_direct_message_target(member, Uuid::from_u128(4)).is_ok());
    }
}
