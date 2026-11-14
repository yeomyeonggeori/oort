//! Who a room frame is for — ADR-0177 증보 D17 (1:1 대화 나가기의 뒤늦은 이벤트, #5857).
//!
//! A member who left a 1:1 conversation keeps their membership and a read floor
//! (`membership.history_from_seq`): the server no longer hands them anything below it. A room
//! channel (`ch:ws<WS>.<CH>`) delivers to every subscriber alike, so a frame about a message below
//! someone's floor cannot go to the room. The relay judges that in one place, right before it
//! publishes:
//!
//! * a frame on any other namespace, or on a room where no live member has a floor (almost every
//!   room), goes out exactly as before — one partial-index probe per drained batch is the whole
//!   added cost;
//! * in a room with a floor, the frame's **target message** is read from [`ROOM_EVENTS`]. When a
//!   live member's floor is above the target's seq, the frame is not published to the room but to
//!   the personal channel ([`personal_channel`]) of each live member who can see the target, with
//!   the room it belongs to under [`ROOM_CHANNEL_KEY`]. Otherwise it goes to the room;
//! * a room frame whose type is not in [`ROOM_EVENTS`], or whose target cannot be read, reaches
//!   only the members without a floor (closed, not open).
//!
//! The outbox row, `message.seq` order, the idempotency key and the single write transaction are
//! untouched: only the publish target changes. Every query names the outbox row's
//! `workspace_id` — the relay runs as the BYPASSRLS role, so the predicate is the tenant boundary.

use std::collections::HashSet;

use momo_db::sqlx::{self, PgPool, Row};
use serde_json::Value;
use uuid::Uuid;

/// The key a diverted frame carries: the room channel the frame would have gone to. Added to the
/// frame's `data` beside `type`/`seq`/`payload`; the room path never carries it.
pub const ROOM_CHANNEL_KEY: &str = "room_channel";

/// Where a room frame's target message is read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// Not about one message of the room's history (live state, ids only): always the room.
    Room,
    /// `data.seq` is the seq of the message the frame describes (the message itself, or a new
    /// message such as a session's progress line).
    EnvelopeSeq,
    /// The id of the message the frame describes is at this pointer in `data`.
    MessageAt(&'static str),
    /// The work session whose id is at this pointer in `data`; its card is the target. A null or
    /// absent id names no session: the room.
    SessionCardAt(&'static str),
    /// `data.seq` when the frame has one; otherwise the approval whose id is at this pointer in
    /// `data`, whose card is the target.
    EnvelopeSeqElseApprovalCardAt(&'static str),
}

/// Every event type published on a room channel and where its target is read from. The inventory
/// test (`tests/room_event_inventory.rs`) keeps this list equal to the room types the server
/// emits.
pub const ROOM_EVENTS: &[(&str, Target)] = &[
    ("message.new", Target::EnvelopeSeq),
    ("message.edited", Target::EnvelopeSeq),
    ("message.deleted", Target::EnvelopeSeq),
    ("reaction.added", Target::EnvelopeSeq),
    ("reaction.removed", Target::EnvelopeSeq),
    ("message.pinned", Target::EnvelopeSeq),
    ("message.unpinned", Target::EnvelopeSeq),
    ("message.unfurl", Target::EnvelopeSeq),
    ("message.unfurl.removed", Target::EnvelopeSeq),
    ("thread.updated", Target::MessageAt("/payload/root_id")),
    ("work.session.started", Target::EnvelopeSeq),
    ("work.session.ended", Target::EnvelopeSeq),
    ("work.session.idle", Target::EnvelopeSeq),
    ("work.session.resumed-to-running", Target::EnvelopeSeq),
    (
        "work.session.control",
        Target::SessionCardAt("/payload/session_id"),
    ),
    (
        "work.session.observer",
        Target::SessionCardAt("/payload/session_id"),
    ),
    (
        "work.session.share_changed",
        Target::SessionCardAt("/payload/session_id"),
    ),
    (
        "work.control.dispatched",
        Target::SessionCardAt("/payload/session_id"),
    ),
    (
        "work.control.acked",
        Target::SessionCardAt("/payload/session_id"),
    ),
    ("agent.partial", Target::EnvelopeSeq),
    ("agent.status", Target::EnvelopeSeq),
    ("approval.requested", Target::EnvelopeSeq),
    ("approval.auto_allowed", Target::EnvelopeSeq),
    (
        "approval.decided",
        Target::EnvelopeSeqElseApprovalCardAt("/payload/approval_id"),
    ),
    ("presence", Target::Room),
    ("member.renamed", Target::Room),
    ("huddle_started", Target::Room),
    ("huddle_participants_changed", Target::Room),
    ("huddle_ended", Target::Room),
    ("work.run.updated", Target::Room),
    ("agent.run.event", Target::Room),
];

/// The classification of one room event type; `None` = unclassified.
pub fn target_of(event_type: &str) -> Option<Target> {
    ROOM_EVENTS
        .iter()
        .find(|(name, _)| *name == event_type)
        .map(|(_, target)| *target)
}

/// The channel id of a room channel `ch:ws<WORKSPACE>.<CHANNEL>`; `None` for every other channel.
/// The workspace inside the name is not trusted: the caller judges against the outbox row's own
/// `workspace_id`.
pub fn room_channel_id(channel: &str) -> Option<Uuid> {
    let rest = channel.strip_prefix("ch:ws")?;
    let (workspace, channel_id) = rest.split_once('.')?;
    Uuid::parse_str(workspace).ok()?;
    Uuid::parse_str(channel_id).ok()
}

/// A member's personal channel — the one the read-state, inbox and scheduled-message frames
/// already use (`momo_messaging::read_state_channel`; a test pins the two together).
pub fn personal_channel(member_id: Uuid) -> String {
    format!("user:read-state#{}", member_id.to_string().to_uppercase())
}

/// Where one room frame goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The room channel, as before.
    Room,
    /// These members' personal channels instead of the room (possibly none).
    Members(Vec<Uuid>),
}

/// The target as far as the frame itself says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resolution {
    Room,
    Seq(i64),
    LookupMessage(Uuid),
    LookupSessionCard(Uuid),
    LookupApprovalCard(Uuid),
    /// Unclassified type or an unreadable target: closed.
    Unknown,
}

fn uuid_at(data: &Value, pointer: &str) -> Option<Uuid> {
    data.pointer(pointer)
        .and_then(Value::as_str)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

fn resolve(data: &Value) -> Resolution {
    let Some(target) = data.get("type").and_then(Value::as_str).and_then(target_of) else {
        return Resolution::Unknown;
    };
    let envelope_seq = data.get("seq").and_then(Value::as_i64);
    match target {
        Target::Room => Resolution::Room,
        Target::EnvelopeSeq => envelope_seq.map_or(Resolution::Unknown, Resolution::Seq),
        Target::MessageAt(pointer) => {
            uuid_at(data, pointer).map_or(Resolution::Unknown, Resolution::LookupMessage)
        }
        Target::SessionCardAt(pointer) => match data.pointer(pointer) {
            None | Some(Value::Null) => Resolution::Room,
            Some(_) => {
                uuid_at(data, pointer).map_or(Resolution::Unknown, Resolution::LookupSessionCard)
            }
        },
        Target::EnvelopeSeqElseApprovalCardAt(pointer) => match envelope_seq {
            Some(seq) => Resolution::Seq(seq),
            None => {
                uuid_at(data, pointer).map_or(Resolution::Unknown, Resolution::LookupApprovalCard)
            }
        },
    }
}

/// The rooms (by channel id) of `rooms` that have a live member with a floor, all in
/// `workspace_id`. One probe of the partial index `membership_history_floor_channel_idx`.
pub async fn rooms_with_floor(
    pool: &PgPool,
    workspace_rooms: &[(Uuid, Uuid)],
) -> Result<HashSet<(Uuid, Uuid)>, sqlx::Error> {
    if workspace_rooms.is_empty() {
        return Ok(HashSet::new());
    }
    let (workspaces, channels): (Vec<Uuid>, Vec<Uuid>) = workspace_rooms.iter().copied().unzip();
    let rows = sqlx::query(FLOORED_ROOMS_SQL)
        .bind(&workspaces)
        .bind(&channels)
        .fetch_all(pool)
        .await?;
    rows.iter()
        .map(|row| Ok((row.try_get("workspace_id")?, row.try_get("channel_id")?)))
        .collect()
}

const FLOORED_ROOMS_SQL: &str = "SELECT DISTINCT ms.workspace_id, ms.channel_id \
       FROM unnest($1::uuid[], $2::uuid[]) AS r (workspace_id, channel_id) \
       JOIN membership ms \
         ON ms.channel_id = r.channel_id \
        AND ms.workspace_id = r.workspace_id \
      WHERE ms.history_from_seq IS NOT NULL \
        AND ms.left_at IS NULL";

const MESSAGE_SEQ_SQL: &str = "SELECT m.seq FROM message m \
      WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.id = $3";

const SESSION_CARD_SEQ_SQL: &str = "SELECT m.seq FROM work_session s \
       JOIN message m ON m.id = s.root_message_id \
      WHERE s.workspace_id = $1 AND m.workspace_id = $1 AND m.channel_id = $2 AND s.id = $3";

const APPROVAL_CARD_SEQ_SQL: &str = "SELECT m.seq FROM approval a \
       JOIN message m ON m.id = a.request_message_id \
      WHERE a.workspace_id = $1 AND m.workspace_id = $1 AND m.channel_id = $2 AND a.id = $3";

const LIVE_MEMBERS_SQL: &str = "SELECT ms.member_id, ms.history_from_seq FROM membership ms \
      WHERE ms.workspace_id = $1 AND ms.channel_id = $2 AND ms.left_at IS NULL";

async fn seq_by(
    pool: &PgPool,
    sql: &str,
    workspace_id: Uuid,
    channel_id: Uuid,
    id: Uuid,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(sql)
        .bind(workspace_id)
        .bind(channel_id)
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// The route of one frame of a room that has a floor (see the module docs).
pub async fn route_in_floored_room(
    pool: &PgPool,
    workspace_id: Uuid,
    channel_id: Uuid,
    data: &Value,
) -> Result<Route, sqlx::Error> {
    let target_seq = match resolve(data) {
        Resolution::Room => return Ok(Route::Room),
        Resolution::Seq(seq) => Some(seq),
        Resolution::LookupMessage(id) => {
            seq_by(pool, MESSAGE_SEQ_SQL, workspace_id, channel_id, id).await?
        }
        Resolution::LookupSessionCard(id) => {
            seq_by(pool, SESSION_CARD_SEQ_SQL, workspace_id, channel_id, id).await?
        }
        Resolution::LookupApprovalCard(id) => {
            seq_by(pool, APPROVAL_CARD_SEQ_SQL, workspace_id, channel_id, id).await?
        }
        Resolution::Unknown => None,
    };
    let members: Vec<(Uuid, Option<i64>)> = sqlx::query(LIVE_MEMBERS_SQL)
        .bind(workspace_id)
        .bind(channel_id)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|row| Ok((row.try_get("member_id")?, row.try_get("history_from_seq")?)))
        .collect::<Result<_, sqlx::Error>>()?;
    Ok(route_for(target_seq, &members))
}

/// The decision itself, without I/O. `target_seq = None` means the target is unknown: only the
/// members without a floor may have the frame.
pub fn route_for(target_seq: Option<i64>, members: &[(Uuid, Option<i64>)]) -> Route {
    let sees = |floor: Option<i64>| match (floor, target_seq) {
        (None, _) => true,
        (Some(floor), Some(seq)) => floor <= seq,
        (Some(_), None) => false,
    };
    if members.iter().all(|(_, floor)| sees(*floor)) {
        return Route::Room;
    }
    let mut audience: Vec<Uuid> = members
        .iter()
        .filter(|(_, floor)| sees(*floor))
        .map(|(member, _)| *member)
        .collect();
    audience.sort();
    Route::Members(audience)
}

/// The frame a member's personal channel carries: the room frame's `data`, byte for byte, plus
/// [`ROOM_CHANNEL_KEY`]. `None` when the room frame's `data` is not an object (no room frame is).
pub fn diverted_data(data: &Value, room_channel: &str) -> Option<Value> {
    let mut object = data.as_object()?.clone();
    object.insert(
        ROOM_CHANNEL_KEY.to_string(),
        Value::String(room_channel.to_string()),
    );
    Some(Value::Object(object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn id(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn only_a_room_channel_names_a_room() {
        let ws = Uuid::parse_str("0198f2c1-7a00-7000-8000-00000000000a").unwrap();
        let ch = Uuid::parse_str("0198f2c1-7a00-7000-8000-00000000000b").unwrap();
        let room = format!(
            "ch:ws{}.{}",
            ws.to_string().to_uppercase(),
            ch.to_string().to_uppercase()
        );
        assert_eq!(room_channel_id(&room), Some(ch));
        for other in [
            format!("user:read-state#{}", ch.to_string().to_uppercase()),
            format!("typing:ws{}.{}", ws, ch),
            format!("agent:ws{}.{}.{}", ws, ch, ch),
            format!("agentwork:ws{}.{}", ws, ch),
            format!("expressions:ws{}", ws),
            "ch:wsnot-a-uuid.also-not".to_string(),
        ] {
            assert_eq!(room_channel_id(&other), None, "{other}");
        }
    }

    #[test]
    fn a_floor_above_the_target_moves_the_frame_to_those_who_see_it() {
        let (leaver, stayer, other) = (id(1), id(2), id(3));
        let members = [(leaver, Some(10)), (stayer, None), (other, Some(4))];
        // At the floor the leaver sees it: nobody is above the target, so the room.
        assert_eq!(route_for(Some(10), &members), Route::Room);
        assert_eq!(route_for(Some(11), &members), Route::Room);
        // One below the floor: the room no longer fits.
        assert_eq!(
            route_for(Some(9), &members),
            Route::Members(vec![stayer, other])
        );
        assert_eq!(route_for(Some(3), &members), Route::Members(vec![stayer]));
        // Unknown target: closed — only the members without a floor.
        assert_eq!(route_for(None, &members), Route::Members(vec![stayer]));
        // No floor at all: the room, whatever the target.
        assert_eq!(route_for(None, &[(stayer, None)]), Route::Room);
    }

    #[test]
    fn each_target_is_read_from_its_place() {
        let root = id(7);
        let frame = |kind: &str, extra: Value| {
            let mut data = json!({"type": kind, "v": 1, "ts": 1, "payload": {}});
            for (key, value) in extra.as_object().unwrap() {
                data[key] = value.clone();
            }
            data
        };
        assert_eq!(
            resolve(&frame("message.edited", json!({"seq": 5}))),
            Resolution::Seq(5)
        );
        assert_eq!(
            resolve(&frame("message.edited", json!({}))),
            Resolution::Unknown
        );
        assert_eq!(
            resolve(&frame(
                "thread.updated",
                json!({"seq": 99, "payload": {"root_id": root.to_string().to_uppercase()}})
            )),
            Resolution::LookupMessage(root),
            "the reply's seq is not the target; the root is"
        );
        assert_eq!(
            resolve(&frame(
                "work.control.acked",
                json!({"payload": {"session_id": null}})
            )),
            Resolution::Room
        );
        assert_eq!(
            resolve(&frame(
                "work.session.observer",
                json!({"payload": {"session_id": root.to_string()}})
            )),
            Resolution::LookupSessionCard(root)
        );
        assert_eq!(
            resolve(&frame(
                "approval.decided",
                json!({"payload": {"approval_id": root.to_string()}})
            )),
            Resolution::LookupApprovalCard(root)
        );
        assert_eq!(
            resolve(&frame(
                "approval.decided",
                json!({"seq": 12, "payload": {"approval_id": root.to_string()}})
            )),
            Resolution::Seq(12)
        );
        assert_eq!(resolve(&frame("presence", json!({}))), Resolution::Room);
        assert_eq!(
            resolve(&frame("message.translated", json!({"seq": 5}))),
            Resolution::Unknown,
            "an unclassified type is closed even when it carries a seq"
        );
    }

    #[test]
    fn a_diverted_frame_is_the_room_frame_plus_its_room() {
        let data =
            json!({"type": "reaction.added", "v": 1, "ts": 3, "seq": 4, "payload": {"emoji": "x"}});
        let diverted = diverted_data(&data, "ch:wsA.B").expect("object");
        let mut expected = data.as_object().unwrap().clone();
        expected.insert(ROOM_CHANNEL_KEY.into(), json!("ch:wsA.B"));
        assert_eq!(diverted, Value::Object(expected));
        assert_eq!(diverted_data(&json!("text"), "ch:wsA.B"), None);
    }

    #[test]
    fn every_room_event_is_classified_once() {
        let mut seen = HashSet::new();
        for (name, _) in ROOM_EVENTS {
            assert!(seen.insert(*name), "{name} is listed twice");
        }
    }
}
