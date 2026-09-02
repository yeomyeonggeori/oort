//! Self display-name rename — the durable half of BZ-4e (#1873).
//!
//! A person's workspace display name is a roster fact: co-members see it on
//! every message, mention picker, and sidebar row. Changing it therefore uses
//! the same single write path presence already established for a member-column
//! mutation (ADR-0160): REST → tenant tx → `member` UPDATE →
//! `emit_outbox(Broadcast)` per `ch:` channel the member is in → relay.
//!
//! There is no pre-existing membership/roster realtime event. The closest
//! analogue is the declared-presence fan-out (`presence.rs`): one no-version
//! `{type, v, ts, payload}` frame per co-member channel, partitioned by
//! `channel_id`, nothing past the roster boundary. This module reuses that
//! envelope and that channel set rather than minting a workspace-level rail.
//!
//! Agents are out of scope here. Their display name lives on the agent profile
//! path; the route's `require_human` plus `kind = 'human'` on the UPDATE keep
//! this surface from becoming a second write for them.

use chrono::Utc;
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::identity::{Member, MemberKind};
use crate::message::cent_channel;

/// The `data.type` of a self-rename broadcast. Same dotted family as
/// `message.new` / `message.edited`; distinct from the ephemeral rail.
pub const MEMBER_RENAMED_BROADCAST_TYPE: &str = "member.renamed";

/// Outcome of a successful self-rename: the stored member and the outbox ids of
/// the per-channel broadcasts (empty when the member shares no channel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayNameRename {
    pub member: Member,
    pub previous_display_name: String,
    pub broadcast_outbox_ids: Vec<i64>,
}

/// The `outbox.payload` for a display-name change on one channel, matching the
/// shared envelope every other broadcast uses (`{type, v, ts, payload}`).
///
/// No `version` — a roster projection is not an ordered channel event; like
/// presence and read-state it never consumes a `message.seq`.
pub fn build_member_renamed_payload(
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    display_name: &str,
    timestamp_ms: i64,
) -> Value {
    let channel = cent_channel(workspace_id, channel_id);
    let member_token = member_id.to_string().to_uppercase();
    let data = json!({
        "type": MEMBER_RENAMED_BROADCAST_TYPE,
        "v": 1,
        "ts": timestamp_ms,
        "payload": {
            "workspace_id": workspace_id.to_string().to_uppercase(),
            "member_id": member_token,
            "display_name": display_name,
        },
    });
    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data,
        version: None,
        idempotency_key: Some(format!(
            "member.renamed:{channel}:{member_token}:{timestamp_ms}"
        )),
    };
    serde_json::to_value(envelope).expect("member.renamed payload serializes")
}

/// Set the **caller's own** display name and broadcast it to their co-members,
/// all in one transaction (single write path).
///
/// `member_id` is the actor, bound by the route to `principal.member_id` — the
/// request path is `/members/me`, so a body cannot name someone else.
/// `kind = 'human'` is belt-and-suspenders on top of the route's `require_human`.
/// Handle, role, and avatar are not in the SET list.
///
/// Returns `Ok(None)` when the update matched no live human member of this
/// workspace — an authorization outcome, returned before any broadcast.
pub async fn rename_own_display_name_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    display_name: &str,
) -> Result<Option<DisplayNameRename>, DbError> {
    let previous = sqlx::query(
        "SELECT id, workspace_id, kind::text AS kind, status::text AS status, \
                display_name, handle \
           FROM member \
          WHERE id = $1 \
            AND workspace_id = $2 \
            AND kind = 'human' \
            AND status = 'active' \
            AND deleted_at IS NULL \
            AND EXISTS ( \
                  SELECT 1 FROM workspace_membership wm \
                   WHERE wm.workspace_id = $2 \
                     AND wm.member_id = $1 \
                ) \
          FOR UPDATE",
    )
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(previous) = previous else {
        return Ok(None);
    };
    let previous_display_name: String = previous.try_get("display_name")?;

    let row = sqlx::query(
        "UPDATE member \
            SET display_name = $1, \
                updated_at = now() \
          WHERE id = $2 \
            AND workspace_id = $3 \
            AND kind = 'human' \
            AND status = 'active' \
            AND deleted_at IS NULL \
        RETURNING id, workspace_id, kind::text AS kind, status::text AS status, \
                  display_name, handle",
    )
    .bind(display_name)
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let kind_label: String = row.try_get("kind")?;
    let kind = MemberKind::from_db_label(&kind_label)
        .ok_or_else(|| sqlx::Error::Decode(format!("unknown member_kind '{kind_label}'").into()))?;
    let member = Member {
        id: row.try_get("id")?,
        workspace_id: row.try_get("workspace_id")?,
        kind,
        status: row.try_get("status")?,
        display_name: row.try_get("display_name")?,
        handle: row.try_get("handle")?,
    };

    let channel_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT ms.channel_id \
           FROM membership ms \
           JOIN channel c \
             ON c.id = ms.channel_id \
            AND c.workspace_id = $1 \
            AND c.archived_at IS NULL \
          WHERE ms.member_id = $2 \
            AND ms.workspace_id = $1 \
            AND ms.left_at IS NULL \
          ORDER BY ms.channel_id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .fetch_all(&mut *conn)
    .await?;

    let now_ms = Utc::now().timestamp_millis();
    let mut broadcast_outbox_ids = Vec::with_capacity(channel_ids.len());
    for channel_id in channel_ids {
        let payload = build_member_renamed_payload(
            workspace_id,
            channel_id,
            member_id,
            &member.display_name,
            now_ms,
        );
        let id = emit_outbox(
            &mut *conn,
            workspace_id,
            OutboxKind::Broadcast,
            "publish",
            &payload,
            Some(channel_id),
        )
        .await?;
        broadcast_outbox_ids.push(id);
    }

    Ok(Some(DisplayNameRename {
        member,
        previous_display_name,
        broadcast_outbox_ids,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rename_payload_rides_the_channel_rail_and_carries_no_seq() {
        let ws = Uuid::from_u128(1);
        let channel = Uuid::from_u128(2);
        let member = Uuid::from_u128(3);
        let payload = build_member_renamed_payload(ws, channel, member, "곽성재", 1234);

        assert_eq!(payload["channel"], json!(cent_channel(ws, channel)));
        assert_eq!(
            payload["data"]["type"],
            json!(MEMBER_RENAMED_BROADCAST_TYPE)
        );
        assert_eq!(payload["data"]["payload"]["display_name"], json!("곽성재"));
        assert_eq!(
            payload["data"]["payload"]["member_id"],
            json!(member.to_string().to_uppercase())
        );
        assert!(payload.get("version").is_none(), "{payload}");
        assert!(payload["data"].get("seq").is_none(), "{payload}");
        assert_eq!(
            payload["idempotency_key"],
            json!(format!(
                "member.renamed:{}:{}:1234",
                cent_channel(ws, channel),
                member.to_string().to_uppercase()
            ))
        );
    }
}
