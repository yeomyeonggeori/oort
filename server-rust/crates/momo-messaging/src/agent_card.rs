//! An agent's **profile card** — tagline (소개), role label (역할 라벨) and custom
//! status — and the one write that changes them (ADR-0186 증보 2026-10-13 v3,
//! V3-2).
//!
//! * `tagline` and `roleLabel` live in `agent.config` (jsonb) under those two
//!   keys: no new column, no new table (ADR-0186 D7). `config` is written at
//!   birth and by `jsonb_set` elsewhere, never wholesale, so merging two keys
//!   cannot clobber anything.
//! * The status triple is the existing `member.status_*` (migration 083). Its
//!   "human only on the wire" rule (ADR-0176) is relaxed for agents by this
//!   addendum; the declared **presence** (`presence_status`, DND) stays human
//!   only, and this module never touches it.
//! * `instructions`, the model, tools, triggers, scopes and the handle are not
//!   here and cannot be reached from here (V3-2c).
//!
//! No broadcast is enqueued: other clients read the new values on their next
//! roster read, the same trade ADR-0161 made for member avatars. A realtime
//! projection is a separate decision.

use chrono::{DateTime, Utc};
use momo_db::{DbError, PgConnection};
use sqlx::Row;
use uuid::Uuid;

/// What a proposal does to one text field.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum FieldPatch {
    /// Not in the proposal: leave it as it is.
    #[default]
    Unchanged,
    /// `null`: remove the field.
    Clear,
    Set(String),
}

impl FieldPatch {
    pub fn is_touched(&self) -> bool {
        !matches!(self, FieldPatch::Unchanged)
    }
}

/// What a proposal does to the custom status. The status is replaced **as a
/// unit**: emoji, text and expiry are one thing a person reads together.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum CardStatusPatch {
    #[default]
    Unchanged,
    Clear,
    Set {
        emoji: Option<String>,
        text: Option<String>,
        /// Mandatory: an agent's status always ends (V3-2).
        expires_at: DateTime<Utc>,
    },
}

impl CardStatusPatch {
    pub fn is_touched(&self) -> bool {
        !matches!(self, CardStatusPatch::Unchanged)
    }
}

/// The card fields a proposal may change, each with its own patch.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentCardPatch {
    pub tagline: FieldPatch,
    pub role_label: FieldPatch,
    pub status: CardStatusPatch,
    /// The avatar **preset** id (`config.avatarPreset`). An image avatar is a
    /// separate row (`agent_avatar_image`) written by `crate::agent_avatar`.
    pub avatar_preset: FieldPatch,
}

/// The card as it stands **now**: an expired status reads as absent, exactly as
/// the roster reads it (lazy expiry).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentCard {
    pub tagline: Option<String>,
    pub role_label: Option<String>,
    pub status_emoji: Option<String>,
    pub status_text: Option<String>,
    /// `config.avatarPreset`, when it is a short string.
    pub avatar_preset: Option<String>,
    /// `member.avatar_image_id` — the approved image avatar, if any.
    pub avatar_image_id: Option<Uuid>,
}

// `config` is also written at agent creation as a free bag, so the two card keys
// are read only when they are strings within their bounds: anything else is "unset".
const CARD_SELECT: &str = "SELECT \
            CASE WHEN jsonb_typeof(a.config->'tagline') = 'string' \
                  AND char_length(a.config->>'tagline') <= 140 \
                 THEN a.config->>'tagline' END AS tagline, \
            CASE WHEN jsonb_typeof(a.config->'roleLabel') = 'string' \
                  AND char_length(a.config->>'roleLabel') <= 24 \
                 THEN a.config->>'roleLabel' END AS role_label, \
            CASE WHEN jsonb_typeof(a.config->'avatarPreset') = 'string' \
                  AND char_length(a.config->>'avatarPreset') <= 24 \
                 THEN a.config->>'avatarPreset' END AS avatar_preset, \
            m.avatar_image_id AS avatar_image_id, \
            CASE WHEN m.status_expires_at IS NULL OR m.status_expires_at > now() \
                 THEN m.status_emoji END AS status_emoji, \
            CASE WHEN m.status_expires_at IS NULL OR m.status_expires_at > now() \
                 THEN m.status_text END AS status_text \
       FROM member m \
       JOIN agent a ON a.workspace_id = m.workspace_id AND a.member_id = m.id \
      WHERE m.workspace_id = $1 AND m.id = $2 AND m.kind = 'agent' \
        AND m.status = 'active' AND m.deleted_at IS NULL";

fn decode(row: &sqlx::postgres::PgRow) -> Result<AgentCard, sqlx::Error> {
    Ok(AgentCard {
        tagline: row.try_get("tagline")?,
        role_label: row.try_get("role_label")?,
        status_emoji: row.try_get("status_emoji")?,
        status_text: row.try_get("status_text")?,
        avatar_preset: row.try_get("avatar_preset")?,
        avatar_image_id: row.try_get("avatar_image_id")?,
    })
}

/// The card now, or `None` when `agent` is not a live agent of the workspace.
pub async fn read_agent_card_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent: Uuid,
) -> Result<Option<AgentCard>, DbError> {
    let row = sqlx::query(CARD_SELECT)
        .bind(workspace_id)
        .bind(agent)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.as_ref().map(decode).transpose()?)
}

/// Lock the agent's member row `FOR UPDATE` and read its display name and card
/// **under that lock**, or `None` when it is not a live agent. The executor calls
/// this before any write and compares the result with what the approval pinned,
/// so a change made between the proposal's resolution and the write (a rename
/// approved in the meantime, say) re-asks instead of being silently overwritten.
pub async fn lock_agent_card_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent: Uuid,
) -> Result<Option<(String, AgentCard)>, DbError> {
    let locked = sqlx::query(
        "SELECT display_name FROM member WHERE workspace_id = $1 AND id = $2 AND kind = 'agent' \
            AND status = 'active' AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(agent)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(locked) = locked else {
        return Ok(None);
    };
    let display_name: String = locked.try_get("display_name")?;
    let Some(card) = read_agent_card_in_tx(conn, workspace_id, agent).await? else {
        return Ok(None);
    };
    Ok(Some((display_name, card)))
}

/// Apply `patch` to `agent` and return the card **as it was**, or `None` when
/// `agent` is not a live agent.
///
/// The member row is locked `FOR UPDATE` first, so the "before" this returns is
/// the value the write replaces — the audit and the result card say what actually
/// changed, not what the card showed when the proposal was drawn.
pub async fn apply_agent_card_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent: Uuid,
    patch: &AgentCardPatch,
) -> Result<Option<AgentCard>, DbError> {
    let locked = sqlx::query(
        "SELECT id FROM member WHERE workspace_id = $1 AND id = $2 AND kind = 'agent' \
            AND status = 'active' AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(agent)
    .fetch_optional(&mut *conn)
    .await?;
    if locked.is_none() {
        return Ok(None);
    }
    let Some(previous) = read_agent_card_in_tx(conn, workspace_id, agent).await? else {
        return Ok(None);
    };

    for (key, field) in [
        ("tagline", &patch.tagline),
        ("roleLabel", &patch.role_label),
        ("avatarPreset", &patch.avatar_preset),
    ] {
        match field {
            FieldPatch::Unchanged => {}
            FieldPatch::Clear => {
                sqlx::query(
                    "UPDATE agent SET config = config - $3::text, updated_at = now() \
                      WHERE workspace_id = $1 AND member_id = $2",
                )
                .bind(workspace_id)
                .bind(agent)
                .bind(key)
                .execute(&mut *conn)
                .await?;
            }
            FieldPatch::Set(value) => {
                sqlx::query(
                    "UPDATE agent SET config = jsonb_set(config, ARRAY[$3::text], \
                         to_jsonb($4::text), true), updated_at = now() \
                      WHERE workspace_id = $1 AND member_id = $2",
                )
                .bind(workspace_id)
                .bind(agent)
                .bind(key)
                .bind(value)
                .execute(&mut *conn)
                .await?;
            }
        }
    }

    match &patch.status {
        CardStatusPatch::Unchanged => {}
        CardStatusPatch::Clear => {
            sqlx::query(
                "UPDATE member SET status_emoji = NULL, status_text = NULL, \
                        status_expires_at = NULL, updated_at = now() \
                  WHERE workspace_id = $1 AND id = $2",
            )
            .bind(workspace_id)
            .bind(agent)
            .execute(&mut *conn)
            .await?;
        }
        CardStatusPatch::Set {
            emoji,
            text,
            expires_at,
        } => {
            sqlx::query(
                "UPDATE member SET status_emoji = $3, status_text = $4, \
                        status_expires_at = $5, updated_at = now() \
                  WHERE workspace_id = $1 AND id = $2",
            )
            .bind(workspace_id)
            .bind(agent)
            .bind(emoji.as_deref())
            .bind(text.as_deref())
            .bind(expires_at)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(Some(previous))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_untouched_patch_touches_nothing() {
        let patch = AgentCardPatch::default();
        assert!(!patch.tagline.is_touched());
        assert!(!patch.role_label.is_touched());
        assert!(!patch.status.is_touched());
        assert!(FieldPatch::Clear.is_touched());
        assert!(FieldPatch::Set("x".into()).is_touched());
        assert!(CardStatusPatch::Clear.is_touched());
    }
}
