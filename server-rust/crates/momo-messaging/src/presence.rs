//! Declared presence status — the durable ③ of ADR-0160 (사용자 프레즌스 6b).
//!
//! Three vocabularies, one of them here. ADR-0160 keeps them apart on purpose:
//!
//!   * ① 연결(자기) — a client-local fact (am I attached), never touches this
//!     crate. It lives in the web client's `connStatus`.
//!   * ② 가용성(타인) — **휘발**, published on the ephemeral rail
//!     (`momo_ephemeral::EphemeralSignal::Presence`), never touches Postgres.
//!   * ③ 선언 상태(의도) — **내구**, this module. `auto`/`away`/`dnd` on
//!     `member.presence_status` (migration 066), changed **only** through the
//!     single write path REST→PG→`emit_outbox(Broadcast)`→relay.
//!
//! The screen dot is `f(③, ②)`, computed at the render edge and **never stored**
//! (ADR-0160 D3): dnd wins, else away, else `auto` resolves to online/offline by
//! availability. This module owns ③ and the broadcast that tells co-members it
//! moved — it deliberately holds no "effective presence" column to drift.
//!
//! ## Why the broadcast fans out to the member's `ch:` channels
//!
//! Read-state (ADR-0109) broadcasts to the owner's **personal** channel because
//! a read cursor is private. A declared status is the opposite: being seen is the
//! whole point, so it broadcasts to the member's **co-members** — and the exact
//! set of co-members is "everyone who shares a `ch:` channel with them", which is
//! the same roster boundary a message fan-out already respects (ADR-0160 D5). So
//! one `Broadcast` per channel the member is in, partitioned by channel like
//! every other channel broadcast, and **nothing leaves the roster** (verification
//! contract #2). A member in zero channels emits no broadcast — the durable write
//! still lands, there is simply no one to tell.
//!
//! ## Agents have no declared presence (ADR-0160 D4)
//!
//! The column exists on every `member` row because `member` is one table
//! (invariant #5), but 프레즌스 is 사람 전용: [`set_presence_status_in_tx`] is
//! reached only behind the route's `require_human`, and [`presence_status_for`]
//! (the roster projection) returns it only for a human. An agent's liveness is
//! its `agent_run`. 사람은 온라인/자리 비움, 에이전트는 작업 중.

use chrono::Utc;
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::message::cent_channel;

/// The `data.type` of a declared-status broadcast. Distinct from the ephemeral
/// `ephemeral.presence` availability frame: this one is durable, arrives on the
/// `ch:` rail, and carries the intent (away/dnd), not the connection fact.
pub const PRESENCE_BROADCAST_TYPE: &str = "presence";

/// `member.presence_status` (migration 066). `auto` is "수동 오버라이드 없음" —
/// deliberately **not** `active`, which is a `member_status` lifecycle label
/// (001_init.sql:12); folding the two axes into one column would put "자리 비움"
/// in the same slot as "정지됨".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresenceStatus {
    /// No manual override: the effective dot is online when available, offline
    /// otherwise. The default for every member.
    Auto,
    /// The member set themselves away.
    Away,
    /// Do not disturb. Durable on purpose: DND survives a reconnect, because a
    /// reconnect that silently cleared it would un-suppress notifications and
    /// wake someone who asked not to be (ADR-0160 D2, 기각 A).
    Dnd,
}

impl PresenceStatus {
    /// The `presence_status` enum label.
    pub fn as_db_label(self) -> &'static str {
        match self {
            PresenceStatus::Auto => "auto",
            PresenceStatus::Away => "away",
            PresenceStatus::Dnd => "dnd",
        }
    }

    /// Parse the enum label back. `None` for anything the enum does not name —
    /// a new status is an enum diff a reviewer sees, never a string that slips
    /// through (ADR-0160 가드 4).
    pub fn from_db_label(label: &str) -> Option<Self> {
        match label {
            "auto" => Some(PresenceStatus::Auto),
            "away" => Some(PresenceStatus::Away),
            "dnd" => Some(PresenceStatus::Dnd),
            _ => None,
        }
    }
}

/// The `outbox.payload` for a declared-status change on one channel, matching
/// the shared envelope every other broadcast uses (`{type, v, ts, payload}`).
///
/// No `version` — a declared status is not an ordered channel event; like
/// read-state it is a no-version projection that never consumes a `message.seq`.
/// The idempotency key coalesces two publishes of the same status to the same
/// channel in the same millisecond (a double-tap), and no more.
pub fn build_presence_payload(
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    status: PresenceStatus,
    timestamp_ms: i64,
) -> Value {
    let channel = cent_channel(workspace_id, channel_id);
    let member_token = member_id.to_string().to_uppercase();
    let data = json!({
        "type": PRESENCE_BROADCAST_TYPE,
        "v": 1,
        "ts": timestamp_ms,
        "payload": {
            "workspace_id": workspace_id.to_string().to_uppercase(),
            "member_id": member_token,
            "presence_status": status.as_db_label(),
        },
    });
    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data,
        version: None,
        idempotency_key: Some(format!(
            "presence:{channel}:{member_token}:{}",
            status.as_db_label()
        )),
    };
    serde_json::to_value(envelope).expect("presence payload serializes")
}

/// Read one member's declared status — **human only**. `None` when the member
/// does not exist in the caller's workspace (RLS), is soft-deleted, or is an
/// agent (프레즌스 is 사람 전용, ADR-0160 D4). Used both by the own-status GET and
/// as the roster projection's source.
pub async fn presence_status_for(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<Option<PresenceStatus>, DbError> {
    let label: Option<String> = sqlx::query_scalar(
        "SELECT presence_status::text \
           FROM member \
          WHERE id = $1 \
            AND kind = 'human' \
            AND deleted_at IS NULL",
    )
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(label.as_deref().and_then(PresenceStatus::from_db_label))
}

/// The outcome of a set: the stored status, and the `outbox.id`s of the
/// per-channel broadcasts it emitted (empty when the member shares no channel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceUpdate {
    pub status: PresenceStatus,
    pub broadcast_outbox_ids: Vec<i64>,
}

/// Set the **caller's own** declared status and broadcast it to their
/// co-members, all in one transaction (ADR-0160 D2, single write path).
///
/// `member_id` is the actor, bound by the route to `principal.member_id` — the
/// request shape never names another member, the strongest guarantee that one
/// person cannot set another's status (the same discipline read-state keeps).
/// `kind = 'human'` is belt-and-suspenders on top of the route's `require_human`.
///
/// Returns `Ok(None)` when the update matched no row (not a live human member of
/// this workspace) — an authorization outcome, returned before any broadcast, so
/// committing the transaction is indistinguishable from rolling it back.
pub async fn set_presence_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    status: PresenceStatus,
) -> Result<Option<PresenceUpdate>, DbError> {
    let updated: Option<String> = sqlx::query_scalar(
        "UPDATE member \
            SET presence_status = $1::presence_status, \
                updated_at = now() \
          WHERE id = $2 \
            AND workspace_id = $3 \
            AND kind = 'human' \
            AND deleted_at IS NULL \
        RETURNING presence_status::text",
    )
    .bind(status.as_db_label())
    .bind(member_id)
    .bind(workspace_id)
    .fetch_optional(&mut *conn)
    .await?;
    if updated.is_none() {
        return Ok(None);
    }

    // The co-member set = the channels this member is currently in. `LEFT`
    // members and archived channels are excluded, so a broadcast never reaches a
    // channel the member no longer belongs to (verification contract #2).
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
        let payload = build_presence_payload(workspace_id, channel_id, member_id, status, now_ms);
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

    Ok(Some(PresenceUpdate {
        status,
        broadcast_outbox_ids,
    }))
}

/// Decode `member.presence_status` off a roster row, human-only.
///
/// The roster query projects `CASE WHEN m.kind = 'human' THEN
/// m.presence_status::text END`, so an agent row carries SQL NULL here and this
/// returns `None` — the field is then omitted from the wire, exactly like
/// `paused` is omitted for a human. A status label the enum does not name also
/// returns `None` rather than surfacing a value no client can render.
pub fn decode_optional_presence(label: Option<&str>) -> Option<PresenceStatus> {
    label.and_then(PresenceStatus::from_db_label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_status_labels_round_trip() {
        for status in [
            PresenceStatus::Auto,
            PresenceStatus::Away,
            PresenceStatus::Dnd,
        ] {
            assert_eq!(
                PresenceStatus::from_db_label(status.as_db_label()),
                Some(status)
            );
        }
        // `active` is a member_status lifecycle label, never a presence one — the
        // whole reason 066 minted a separate enum.
        assert_eq!(PresenceStatus::from_db_label("active"), None);
        assert_eq!(PresenceStatus::from_db_label("online"), None);
    }

    #[test]
    fn the_presence_payload_rides_the_channel_rail_and_carries_no_seq() {
        let ws = Uuid::from_u128(1);
        let channel = Uuid::from_u128(2);
        let member = Uuid::from_u128(3);
        let payload = build_presence_payload(ws, channel, member, PresenceStatus::Dnd, 1234);

        // It arrives on the co-members' `ch:` rail, not a personal channel — being
        // seen is the point (ADR-0160 D2, unlike read-state).
        assert_eq!(payload["channel"], json!(cent_channel(ws, channel)));
        assert_eq!(payload["data"]["type"], json!(PRESENCE_BROADCAST_TYPE));
        assert_eq!(payload["data"]["payload"]["presence_status"], json!("dnd"));
        assert_eq!(
            payload["data"]["payload"]["member_id"],
            json!(member.to_string().to_uppercase())
        );
        // A declared status is a no-version projection; it must not consume a seq.
        assert!(payload.get("version").is_none(), "{payload}");
        assert!(payload["data"].get("seq").is_none(), "{payload}");
    }

    #[test]
    fn a_status_the_enum_does_not_name_decodes_to_none() {
        assert_eq!(
            decode_optional_presence(Some("away")),
            Some(PresenceStatus::Away)
        );
        assert_eq!(decode_optional_presence(None), None);
        assert_eq!(decode_optional_presence(Some("busy")), None);
    }
}
