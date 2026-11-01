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
//! [`rename_own_display_name_in_tx`] is human-only: the route's `require_human`
//! plus `kind = 'human'` on the UPDATE keep `PATCH …/members/me` from becoming a
//! second write for agents. An **agent's** display name is renamed by its owner or
//! an admin (`PATCH …/agents/{agent}`) or, after a person approves it, by the
//! agent itself or an agent of the same owner (`agent.rename`, ADR-0186 증보 V4):
//! both go through [`rename_agent_display_name_in_tx`], this module's one agent
//! write, so the roster broadcast cannot differ between them. For the workspace's
//! team AI that same write also moves its aliases (ADR-0201 증보 v3 B10, #4966).

use chrono::Utc;
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::identity::{Member, MemberKind};
use crate::message::cent_channel;
use crate::name_guard::{is_reserved_mention_word, NameRejected};
use crate::team_ai_alias::{self, AliasSync};
use momo_settings::is_handle_banned_in_tx;

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
    /// ADR-0201 증보 v3 B10-3 (#4966): what became of the team AI's alias for this name, written in
    /// the same transaction. `None` for every other member, and for the helper while its switch is
    /// off. The callers add [`AliasSync::audit_detail`] to their `member.renamed` audit row (B10-6).
    pub alias_sync: Option<AliasSync>,
}

/// Outcome of a successful self handle change. Past `message.body` bytes that
/// mention `@oldhandle` are not rewritten (ADR-0185 E2). Co-members still
/// need the new handle, so a successful change rides the same `member.renamed`
/// rail as a display-name write — with `handle` in the payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleRename {
    pub member: Member,
    pub previous_handle: String,
    pub broadcast_outbox_ids: Vec<i64>,
}

/// Handle-allocation refusal that is not a unique-constraint 409.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleChangeRejected {
    /// Same sentence/status join, agent create, and hosted-agent create use
    /// (`JoinRejection::Banned` → 403 `member is banned from this workspace`).
    Banned,
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
    handle: &str,
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
            "handle": handle,
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

    let broadcast_outbox_ids = enqueue_member_renamed(
        conn,
        workspace_id,
        member_id,
        &member.display_name,
        &member.handle,
    )
    .await?;

    Ok(Some(DisplayNameRename {
        member,
        previous_display_name,
        broadcast_outbox_ids,
        alias_sync: None,
    }))
}

/// Serialise display-name changes within a workspace for the length of the
/// transaction, so two renames that each pass the collision check cannot both
/// commit a colliding pair. (`member` is unique only on `handle`; the name
/// collision rule of ADR-0186 증보 V4 is enforced here, not by an index.)
pub async fn lock_display_name_namespace_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<(), DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('display-name:' || $1::text, 0))")
        .bind(workspace_id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Every non-deleted member of the workspace except `except`, as
/// `(member id, display name, handle)` — the roster
/// [`crate::name_guard::conflicts_with_roster`] compares against. Suspended
/// members count: their name comes back with them.
pub async fn load_roster_names_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    except: Uuid,
) -> Result<Vec<(Uuid, String, String)>, DbError> {
    Ok(sqlx::query_as(
        "SELECT id, display_name, handle FROM member \
          WHERE workspace_id = $1 AND deleted_at IS NULL AND id <> $2",
    )
    .bind(workspace_id)
    .bind(except)
    .fetch_all(&mut *conn)
    .await?)
}

/// Set an **agent's** display name and broadcast it, in the caller's transaction.
///
/// The one agent write shared by the human route and the approved `agent.rename` /
/// `agent.profile.update` actions. It judges nothing about *who* may rename (the callers do) — only
/// that `target` is a live agent of this workspace. `handle`, role, avatar and every profile field
/// stay put. `Ok(Ok(None))` = no such live agent, returned before any broadcast.
///
/// ADR-0201 증보 v3 B10 (#4966) adds two things for the workspace's **team AI** (the helper), and
/// nothing for any other agent:
///
/// * a name that is one of [`crate::name_guard::RESERVED_MENTION_WORDS`] is refused with
///   `Ok(Err(NameRejected::Reserved))` **before** anything is written — a display name is a mention
///   target (`@표시 이름`), so the helper may not wear `all`, `admin`, `모두`, …;
/// * the helper's aliases follow the new name **in this same transaction**
///   ([`team_ai_alias::sync_team_ai_aliases_in_tx`]). Every door — the settings route, the card
///   `agent.rename`, the card `agent.profile.update` — comes through here, so none can rename the
///   helper without its alias following, and a failure of either rolls back both.
pub async fn rename_agent_display_name_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    target_agent: Uuid,
    display_name: &str,
) -> Result<Result<Option<DisplayNameRename>, NameRejected>, DbError> {
    // The team AI's alias lock comes before its member row, as in the switch-on and switch-off
    // paths, so a rename racing a switch-on cannot deadlock with it.
    let is_team_ai =
        team_ai_alias::is_team_ai_member_in_tx(conn, workspace_id, target_agent).await?;
    if is_team_ai {
        team_ai_alias::lock_aliases_in_tx(conn, workspace_id).await?;
    }
    let previous = sqlx::query(
        "SELECT display_name FROM member \
          WHERE id = $1 AND workspace_id = $2 AND kind = 'agent' \
            AND status = 'active' AND deleted_at IS NULL \
          FOR UPDATE",
    )
    .bind(target_agent)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(previous) = previous else {
        return Ok(Ok(None));
    };
    let previous_display_name: String = previous.try_get("display_name")?;

    if is_team_ai && is_reserved_mention_word(display_name) {
        return Ok(Err(NameRejected::Reserved));
    }

    let row = sqlx::query(
        "UPDATE member SET display_name = $1, updated_at = now() \
          WHERE id = $2 AND workspace_id = $3 AND kind = 'agent' \
            AND status = 'active' AND deleted_at IS NULL \
        RETURNING id, workspace_id, kind::text AS kind, status::text AS status, \
                  display_name, handle",
    )
    .bind(display_name)
    .bind(target_agent)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(Ok(None));
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
    let broadcast_outbox_ids = enqueue_member_renamed(
        conn,
        workspace_id,
        target_agent,
        &member.display_name,
        &member.handle,
    )
    .await?;
    // Load-bearing name: the alias test names this call. Sabotage: delete it and the name changes
    // while the aliases stay — on every door at once.
    let alias_sync = if is_team_ai {
        team_ai_alias::sync_team_ai_aliases_in_tx(
            conn,
            workspace_id,
            target_agent,
            &member.display_name,
        )
        .await?
    } else {
        None
    };
    Ok(Ok(Some(DisplayNameRename {
        member,
        previous_display_name,
        broadcast_outbox_ids,
        alias_sync,
    })))
}

/// One `member.renamed` broadcast per live `ch:` channel the member is in.
/// Display-name and handle writes share this rail so co-members refetch the
/// same roster event. Sabotage of the handle path: stop calling
/// [`enqueue_handle_change_fanout`].
async fn enqueue_member_renamed(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    display_name: &str,
    handle: &str,
) -> Result<Vec<i64>, DbError> {
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
            display_name,
            handle,
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
    Ok(broadcast_outbox_ids)
}

/// Load-bearing name: the handle-change test's include_str names this call.
/// Sabotage: delete the call in [`change_own_handle_in_tx`].
async fn enqueue_handle_change_fanout(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    display_name: &str,
    handle: &str,
) -> Result<Vec<i64>, DbError> {
    enqueue_member_renamed(conn, workspace_id, member_id, display_name, handle).await
}

/// Set the **caller's own** handle. `kind = 'human'` is belt-and-suspenders on
/// top of the route's `require_human`. Display name, role, and avatar stay put.
///
/// A unique violation on `member_handle_uniq` is returned as [`DbError`] so the
/// transaction rolls back; the route maps it onto join's `HandleTaken` 409
/// sentence. A banned handle is [`HandleChangeRejected::Banned`] (join's
/// 403 sentence). Past `message.body` bytes are not touched — `@oldhandle` in a
/// previously stored body stays `@oldhandle`.
pub async fn change_own_handle_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    handle: &str,
) -> Result<Result<Option<HandleRename>, HandleChangeRejected>, DbError> {
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
        return Ok(Ok(None));
    };
    let previous_handle: String = previous.try_get("handle")?;
    if previous_handle == handle {
        let kind_label: String = previous.try_get("kind")?;
        let kind = MemberKind::from_db_label(&kind_label).ok_or_else(|| {
            sqlx::Error::Decode(format!("unknown member_kind '{kind_label}'").into())
        })?;
        return Ok(Ok(Some(HandleRename {
            member: Member {
                id: previous.try_get("id")?,
                workspace_id: previous.try_get("workspace_id")?,
                kind,
                status: previous.try_get("status")?,
                display_name: previous.try_get("display_name")?,
                handle: previous_handle.clone(),
            },
            previous_handle,
            broadcast_outbox_ids: Vec::new(),
        })));
    }

    // Load-bearing ban. Sabotage: delete this check and the banned-handle
    // test must go RED — join/agents/hosted-agent would still refuse, this
    // path would allocate.
    if is_handle_banned_in_tx(conn, handle).await? {
        return Ok(Err(HandleChangeRejected::Banned));
    }

    let row = sqlx::query(
        "UPDATE member \
            SET handle = $1, \
                updated_at = now() \
          WHERE id = $2 \
            AND workspace_id = $3 \
            AND kind = 'human' \
            AND status = 'active' \
            AND deleted_at IS NULL \
        RETURNING id, workspace_id, kind::text AS kind, status::text AS status, \
                  display_name, handle",
    )
    .bind(handle)
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(Ok(None));
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
    let broadcast_outbox_ids = enqueue_handle_change_fanout(
        conn,
        workspace_id,
        member_id,
        &member.display_name,
        &member.handle,
    )
    .await?;
    Ok(Ok(Some(HandleRename {
        member,
        previous_handle,
        broadcast_outbox_ids,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rename_payload_rides_the_channel_rail_and_carries_no_seq() {
        let ws = Uuid::from_u128(1);
        let channel = Uuid::from_u128(2);
        let member = Uuid::from_u128(3);
        let payload = build_member_renamed_payload(ws, channel, member, "곽성재", "seongjae", 1234);

        assert_eq!(payload["channel"], json!(cent_channel(ws, channel)));
        assert_eq!(
            payload["data"]["type"],
            json!(MEMBER_RENAMED_BROADCAST_TYPE)
        );
        assert_eq!(payload["data"]["payload"]["display_name"], json!("곽성재"));
        assert_eq!(payload["data"]["payload"]["handle"], json!("seongjae"));
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
