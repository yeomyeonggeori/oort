//! ADR-0224 D5·D8·D11 — reading a public channel before joining it.
//!
//! The preview answers "what is being said here?" for a person deciding whether to join,
//! and nothing more. It is read-only and **allow-listed**: the statements below select the
//! few columns the preview carries and nothing else, rather than reading the history page
//! and dropping keys afterwards. So there is no `props` (cards, streams, signatures), no
//! quote, no thread participants, no reactions, no link cards, no read state, and of an
//! attachment only its name — no id, type, size or media summary, so the preview names no
//! address the attachment content route would answer.
//!
//! **The same gate as the browse list and the join.** Both statements embed the one channel
//! piece ([`CHANNEL_OPEN_TO_PEOPLE_SQL`]: public, not archived, `browse_listed` on) inside
//! the statement that reads, so a private channel, a DM, a browse-off public channel, an
//! archived channel and an unknown id are all "no channel" here — there is no separate
//! pre-check that a later edit could leave behind. The person half
//! ([`crate::judge_browse_person`]) is the route's, judged before this module is called.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::channel_browse::CHANNEL_OPEN_TO_PEOPLE_SQL;

/// How many of the newest top-level messages a preview carries. One screen; no paging.
pub const PREVIEW_MESSAGE_LIMIT: i64 = 50;

/// The channel a preview is of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewChannel {
    pub id: Uuid,
    pub name: String,
    pub topic: Option<String>,
    /// Live memberships of active, not-deleted members — people and agents together, the
    /// same count as the browse list's row.
    pub member_count: i64,
    /// The caller has a live membership in it. The shape of the answer does not depend on it.
    pub is_member: bool,
}

/// One message of a preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewMessage {
    pub id: Uuid,
    /// `None` on a deleted message.
    pub body: Option<String>,
    /// `None` when the author is no longer an active member (suspended, removed): the
    /// people list a member reads names active members only, so the preview names no one else.
    pub author_display_name: Option<String>,
    /// `human` or `agent`.
    pub author_kind: String,
    pub created_at_ms: i64,
    /// Rewritten by its author (and not deleted).
    pub edited: bool,
    pub deleted: bool,
    /// Replies under it; the replies themselves are not in the preview.
    pub reply_count: i64,
    /// Names of its completed attachments, oldest first. Empty on a deleted message.
    pub attachment_names: Vec<String>,
}

/// Make the surrounding transaction a read-only snapshot. Must be the transaction's first
/// statement (before the workspace binding): the preview then cannot write a read position,
/// a membership, an audit row or an outbox row even by mistake — the database refuses it —
/// and its two statements read one snapshot.
pub async fn begin_preview_snapshot(conn: &mut PgConnection) -> Result<(), DbError> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// The preview of `channel_id` for `viewer_member_id`: the channel and its newest
/// [`PREVIEW_MESSAGE_LIMIT`] top-level messages, newest first. `None` when the id is not a
/// channel open to people in this workspace — one answer for every reason.
pub async fn preview_channel_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    channel_id: Uuid,
    viewer_member_id: Uuid,
) -> Result<Option<(PreviewChannel, Vec<PreviewMessage>)>, DbError> {
    let header_sql = format!(
        "SELECT c.id, \
                COALESCE(c.name, '') AS name, \
                c.topic, \
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
                     AND me.member_id = $3 \
                     AND me.left_at IS NULL \
                ) AS is_member \
           FROM channel c \
          WHERE c.workspace_id = $1 \
            AND c.id = $2 \
            AND {open}",
        open = CHANNEL_OPEN_TO_PEOPLE_SQL,
    );
    let Some(row) = sqlx::query(&header_sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(viewer_member_id)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };
    let channel = PreviewChannel {
        id: row.try_get("id").map_err(DbError::from)?,
        name: row.try_get("name").map_err(DbError::from)?,
        topic: row.try_get("topic").map_err(DbError::from)?,
        member_count: row.try_get("member_count").map_err(DbError::from)?,
        is_member: row.try_get("is_member").map_err(DbError::from)?,
    };

    // Top-level messages only (a thread reply, also one sent "to the channel too", stays in
    // its thread). The channel piece sits in this statement as well: the messages are read
    // through the gate, not beside it.
    let messages_sql = format!(
        "SELECT m.id, \
                CASE WHEN m.state = 'deleted' OR m.deleted_at IS NOT NULL THEN NULL \
                     ELSE m.body END AS body, \
                CASE WHEN a.status = 'active' AND a.deleted_at IS NULL \
                     THEN a.display_name END AS author_display_name, \
                a.kind::text AS author_kind, \
                floor(extract(epoch from m.created_at) * 1000)::bigint AS created_at_ms, \
                (m.edited_at IS NOT NULL \
                 AND m.state <> 'deleted' AND m.deleted_at IS NULL) AS edited, \
                (m.state = 'deleted' OR m.deleted_at IS NOT NULL) AS deleted, \
                COALESCE(t.reply_count, 0)::bigint AS reply_count, \
                COALESCE(att.names, ARRAY[]::text[]) AS attachment_names \
           FROM channel c \
           JOIN message m \
             ON m.workspace_id = c.workspace_id AND m.channel_id = c.id \
           JOIN member a \
             ON a.workspace_id = m.workspace_id AND a.id = m.author_member_id \
           LEFT JOIN thread t \
             ON t.root_id = m.id AND t.reply_count > 0 \
           LEFT JOIN LATERAL ( \
             SELECT array_agg(f.name ORDER BY f.created_at, f.id) AS names \
               FROM attachment f \
              WHERE f.message_id = m.id AND f.status = 'complete' \
                AND m.state <> 'deleted' AND m.deleted_at IS NULL \
           ) att ON true \
          WHERE c.workspace_id = $1 \
            AND c.id = $2 \
            AND {open} \
            AND m.root_id IS NULL \
          ORDER BY m.seq DESC \
          LIMIT $3",
        open = CHANNEL_OPEN_TO_PEOPLE_SQL,
    );
    let rows = sqlx::query(&messages_sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(PREVIEW_MESSAGE_LIMIT)
        .fetch_all(&mut *conn)
        .await?;
    let messages = rows
        .iter()
        .map(|row| {
            Ok(PreviewMessage {
                id: row.try_get("id")?,
                body: row.try_get("body")?,
                author_display_name: row.try_get("author_display_name")?,
                author_kind: row.try_get("author_kind")?,
                created_at_ms: row.try_get("created_at_ms")?,
                edited: row.try_get("edited")?,
                deleted: row.try_get("deleted")?,
                reply_count: row.try_get("reply_count")?,
                attachment_names: row.try_get("attachment_names")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)?;
    Ok(Some((channel, messages)))
}
