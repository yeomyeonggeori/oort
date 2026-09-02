//! Declared presence status — the durable ③ of ADR-0160 (사용자 프레즌스 6b)
//! plus the orthogonal custom status of ADR-0176 (#1889).
//!
//! Three vocabularies, one of them here. ADR-0160 keeps them apart on purpose:
//!
//!   * ① 연결(자기) — a client-local fact (am I attached), never touches this
//!     crate. It lives in the web client's `connStatus`.
//!   * ② 가용성(타인) — **휘발**, published on the ephemeral rail
//!     (`momo_ephemeral::EphemeralSignal::Presence`), never touches Postgres.
//!   * ③ 선언 상태(의도) — **내구**, this module. `auto`/`away`/`dnd` on
//!     `member.presence_status` (migration 068), changed **only** through the
//!     single write path REST→PG→`emit_outbox(Broadcast)`→relay.
//!
//! ADR-0176 rides the same surface: `status_emoji` / `status_text` /
//! `status_expires_at` live on the same `member` row (migration 083) and the
//! same `type: presence` `ch:` broadcast. No second rail, no sweeper job —
//! a reached expiry is ignored on read (lazy delete).
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
//!
//! ## Audit
//!
//! None. The original presence PUT wrote no `audit_log` row (personal declared
//! intent, not a membership act). ADR-0176 follows that convention — 과감사
//! 금지.

use chrono::{DateTime, Utc};
use momo_db::DbError;
use momo_outbox::{emit_outbox, OutboxKind};
use momo_wire::payload::BroadcastPayload;
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::message::cent_channel;

/// The `data.type` of a declared-status broadcast. Distinct from the ephemeral
/// `ephemeral.presence` availability frame: this one is durable, arrives on the
/// `ch:` rail, and carries the intent (away/dnd), not the connection fact.
pub const PRESENCE_BROADCAST_TYPE: &str = "presence";

/// Cap on `member.status_emoji` — length/code-point bound, not a grapheme or
/// emoji-property classifier (ADR-0176: 엄밀 이모지 판별은 과설계 금지).
/// Matches the CHECK on migration 083. 32 scalars still clear a ZWJ family.
pub const STATUS_EMOJI_MAX_CHARS: usize = 32;

/// Cap on `member.status_text` after trim. Matches the CHECK on migration 083.
pub const STATUS_TEXT_MAX_CHARS: usize = 80;

/// `member.presence_status` (migration 068). `auto` is "수동 오버라이드 없음" —
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

/// One field of a custom-status write: omitted, set, or cleared.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum StatusPatch<T> {
    #[default]
    Absent,
    Set(Option<T>),
}

impl<T> StatusPatch<T> {
    fn is_patch(&self) -> bool {
        matches!(self, StatusPatch::Set(_))
    }

    fn as_set(&self) -> Option<Option<&T>> {
        match self {
            StatusPatch::Absent => None,
            StatusPatch::Set(value) => Some(value.as_ref()),
        }
    }
}

/// Per-field patch for the ADR-0176 triple. Absent fields leave the stored
/// column alone so a `{status}`-only PUT (the ADR-0160 client) does not wipe
/// a custom status.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CustomStatusPatch {
    pub emoji: StatusPatch<String>,
    pub text: StatusPatch<String>,
    pub expires_at: StatusPatch<DateTime<Utc>>,
}

impl CustomStatusPatch {
    pub fn is_absent(&self) -> bool {
        matches!(self.emoji, StatusPatch::Absent)
            && matches!(self.text, StatusPatch::Absent)
            && matches!(self.expires_at, StatusPatch::Absent)
    }
}

/// Visible custom status after the lazy-expire filter.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CustomStatus {
    pub emoji: Option<String>,
    pub text: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl CustomStatus {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.emoji.is_none() && self.text.is_none()
    }

    /// Read projection: a reached expiry, or a row with no emoji and no text,
    /// is indistinguishable from "no custom status".
    pub fn visible_at(
        emoji: Option<String>,
        text: Option<String>,
        expires_at: Option<DateTime<Utc>>,
        now: DateTime<Utc>,
    ) -> Self {
        if expires_at.is_some_and(|at| at <= now) {
            return Self::empty();
        }
        if emoji.is_none() && text.is_none() {
            return Self::empty();
        }
        CustomStatus {
            emoji,
            text,
            expires_at,
        }
    }
}

/// Human member's durable declared status, custom fields already expire-filtered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredPresence {
    pub status: PresenceStatus,
    pub custom: CustomStatus,
}

/// Why a custom-status field was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CustomStatusInvalid {
    #[error("statusEmoji must not contain control characters")]
    EmojiControl,
    #[error("statusEmoji must contain at most 32 characters")]
    EmojiTooLong,
    #[error("statusText must be at most 80 characters")]
    TextTooLong,
    #[error("invalid statusExpiresAtMs")]
    ExpiresUnrepresentable,
}

/// Trim; empty becomes `None`; cap [`STATUS_EMOJI_MAX_CHARS`]; refuse controls.
/// Not an emoji-property classifier.
pub fn normalize_status_emoji(raw: Option<&str>) -> Result<Option<String>, CustomStatusInvalid> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().any(char::is_control) {
        return Err(CustomStatusInvalid::EmojiControl);
    }
    if trimmed.chars().count() > STATUS_EMOJI_MAX_CHARS {
        return Err(CustomStatusInvalid::EmojiTooLong);
    }
    Ok(Some(trimmed.to_string()))
}

/// Trim; empty becomes `None`; cap [`STATUS_TEXT_MAX_CHARS`].
pub fn normalize_status_text(raw: Option<&str>) -> Result<Option<String>, CustomStatusInvalid> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > STATUS_TEXT_MAX_CHARS {
        return Err(CustomStatusInvalid::TextTooLong);
    }
    Ok(Some(trimmed.to_string()))
}

/// Epoch milliseconds → timestamptz. Past values are accepted: the read path
/// ignores a reached expiry (lazy delete), so a write of an already-past stamp
/// is just "clear on the next read".
pub fn status_expires_at_from_ms(ms: i64) -> Result<DateTime<Utc>, CustomStatusInvalid> {
    DateTime::from_timestamp_millis(ms).ok_or(CustomStatusInvalid::ExpiresUnrepresentable)
}

/// The `outbox.payload` for a declared-status change on one channel, matching
/// the shared envelope every other broadcast uses (`{type, v, ts, payload}`).
///
/// No `version` — a declared status is not an ordered channel event; like
/// read-state it is a no-version projection that never consumes a `message.seq`.
/// The idempotency key includes the custom-status triple so a custom-only change
/// (same `presence_status`) is not coalesced away as a double-tap of ③.
pub fn build_presence_payload(
    workspace_id: Uuid,
    channel_id: Uuid,
    member_id: Uuid,
    status: PresenceStatus,
    custom: &CustomStatus,
    timestamp_ms: i64,
) -> Value {
    let channel = cent_channel(workspace_id, channel_id);
    let member_token = member_id.to_string().to_uppercase();
    let expires_ms = custom.expires_at.map(|at| at.timestamp_millis());
    let data = json!({
        "type": PRESENCE_BROADCAST_TYPE,
        "v": 1,
        "ts": timestamp_ms,
        "payload": {
            "workspace_id": workspace_id.to_string().to_uppercase(),
            "member_id": member_token,
            "presence_status": status.as_db_label(),
            "status_emoji": custom.emoji,
            "status_text": custom.text,
            "status_expires_at_ms": expires_ms,
        },
    });
    let envelope = BroadcastPayload {
        channel: channel.clone(),
        data,
        version: None,
        idempotency_key: Some(format!(
            "presence:{channel}:{member_token}:{}:{}:{}:{}",
            status.as_db_label(),
            custom.emoji.as_deref().unwrap_or(""),
            custom.text.as_deref().unwrap_or(""),
            expires_ms.unwrap_or(0)
        )),
    };
    serde_json::to_value(envelope).expect("presence payload serializes")
}

/// Read one member's declared status — **human only**. `None` when the member
/// does not exist in the caller's workspace (RLS), is soft-deleted, or is an
/// agent (프레즌스 is 사람 전용, ADR-0160 D4). Used both by the own-status GET and
/// as the roster projection's source.
pub async fn declared_presence_for(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<Option<DeclaredPresence>, DbError> {
    let row = sqlx::query(
        "SELECT presence_status::text, status_emoji, status_text, status_expires_at \
           FROM member \
          WHERE id = $1 \
            AND kind = 'human' \
            AND deleted_at IS NULL",
    )
    .bind(member_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let label: Option<String> = row.try_get("presence_status")?;
    let Some(status) = label.as_deref().and_then(PresenceStatus::from_db_label) else {
        return Ok(None);
    };
    let emoji: Option<String> = row.try_get("status_emoji")?;
    let text: Option<String> = row.try_get("status_text")?;
    let expires_at: Option<DateTime<Utc>> = row.try_get("status_expires_at")?;
    Ok(Some(DeclaredPresence {
        status,
        custom: CustomStatus::visible_at(emoji, text, expires_at, Utc::now()),
    }))
}

/// Convenience wrapper: just the ADR-0160 ③ label.
pub async fn presence_status_for(
    conn: &mut PgConnection,
    member_id: Uuid,
) -> Result<Option<PresenceStatus>, DbError> {
    Ok(declared_presence_for(conn, member_id)
        .await?
        .map(|declared| declared.status))
}

/// The outcome of a set: the stored status, the visible custom triple, and the
/// `outbox.id`s of the per-channel broadcasts it emitted (empty when the member
/// shares no channel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceUpdate {
    pub status: PresenceStatus,
    pub custom: CustomStatus,
    pub broadcast_outbox_ids: Vec<i64>,
}

/// Set the **caller's own** declared status (and optional custom status) and
/// broadcast it to their co-members, all in one transaction (ADR-0160 D2,
/// ADR-0176 same rail).
///
/// `member_id` is the actor, bound by the route to `principal.member_id` — the
/// request shape never names another member, the strongest guarantee that one
/// person cannot set another's status (the same discipline read-state keeps).
/// `kind = 'human'` is belt-and-suspenders on top of the route's `require_human`.
///
/// Returns `Ok(None)` when the update matched no row (not a live human member of
/// this workspace) — an authorization outcome, returned before any broadcast, so
/// committing the transaction is indistinguishable from rolling it back.
pub async fn set_declared_presence_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    status: PresenceStatus,
    custom: CustomStatusPatch,
) -> Result<Option<PresenceUpdate>, DbError> {
    let patch_emoji = custom.emoji.is_patch();
    let patch_text = custom.text.is_patch();
    let patch_expires = custom.expires_at.is_patch();
    let emoji_value = custom
        .emoji
        .as_set()
        .and_then(|value| value.map(|s| s.to_string()));
    let text_value = custom
        .text
        .as_set()
        .and_then(|value| value.map(|s| s.to_string()));
    let expires_value = custom.expires_at.as_set().and_then(|value| value.copied());

    let row = sqlx::query(
        "UPDATE member \
            SET presence_status = $1::presence_status, \
                status_emoji = CASE WHEN $4 THEN $5 ELSE status_emoji END, \
                status_text = CASE WHEN $6 THEN $7 ELSE status_text END, \
                status_expires_at = CASE WHEN $8 THEN $9 ELSE status_expires_at END, \
                updated_at = now() \
          WHERE id = $2 \
            AND workspace_id = $3 \
            AND kind = 'human' \
            AND deleted_at IS NULL \
        RETURNING presence_status::text, status_emoji, status_text, status_expires_at",
    )
    .bind(status.as_db_label())
    .bind(member_id)
    .bind(workspace_id)
    .bind(patch_emoji)
    .bind(emoji_value)
    .bind(patch_text)
    .bind(text_value)
    .bind(patch_expires)
    .bind(expires_value)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let stored_status =
        PresenceStatus::from_db_label(row.try_get::<String, _>("presence_status")?.as_str())
            .unwrap_or(status);
    let stored_custom = CustomStatus::visible_at(
        row.try_get("status_emoji")?,
        row.try_get("status_text")?,
        row.try_get("status_expires_at")?,
        Utc::now(),
    );

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
        let payload = build_presence_payload(
            workspace_id,
            channel_id,
            member_id,
            stored_status,
            &stored_custom,
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

    Ok(Some(PresenceUpdate {
        status: stored_status,
        custom: stored_custom,
        broadcast_outbox_ids,
    }))
}

/// ADR-0160-only write: leave the custom-status columns untouched.
pub async fn set_presence_status_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    status: PresenceStatus,
) -> Result<Option<PresenceUpdate>, DbError> {
    set_declared_presence_in_tx(
        conn,
        workspace_id,
        member_id,
        status,
        CustomStatusPatch::default(),
    )
    .await
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
        // whole reason 068 minted a separate enum.
        assert_eq!(PresenceStatus::from_db_label("active"), None);
        assert_eq!(PresenceStatus::from_db_label("online"), None);
    }

    #[test]
    fn the_presence_payload_rides_the_channel_rail_and_carries_no_seq() {
        let ws = Uuid::from_u128(1);
        let channel = Uuid::from_u128(2);
        let member = Uuid::from_u128(3);
        let payload = build_presence_payload(
            ws,
            channel,
            member,
            PresenceStatus::Dnd,
            &CustomStatus::empty(),
            1234,
        );

        // It arrives on the co-members' `ch:` rail, not a personal channel — being
        // seen is the point (ADR-0160 D2, unlike read-state).
        assert_eq!(payload["channel"], json!(cent_channel(ws, channel)));
        assert_eq!(payload["data"]["type"], json!(PRESENCE_BROADCAST_TYPE));
        assert_eq!(payload["data"]["payload"]["presence_status"], json!("dnd"));
        assert_eq!(
            payload["data"]["payload"]["member_id"],
            json!(member.to_string().to_uppercase())
        );
        assert_eq!(payload["data"]["payload"]["status_emoji"], json!(null));
        assert_eq!(payload["data"]["payload"]["status_text"], json!(null));
        // A declared status is a no-version projection; it must not consume a seq.
        assert!(payload.get("version").is_none(), "{payload}");
        assert!(payload["data"].get("seq").is_none(), "{payload}");
    }

    #[test]
    fn custom_status_rides_the_same_presence_payload() {
        let expires = DateTime::from_timestamp_millis(1_700_000_000_000).expect("ms");
        let custom = CustomStatus {
            emoji: Some("📅".into()),
            text: Some("회의 중".into()),
            expires_at: Some(expires),
        };
        let payload = build_presence_payload(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            PresenceStatus::Away,
            &custom,
            9,
        );
        assert_eq!(payload["data"]["payload"]["status_emoji"], json!("📅"));
        assert_eq!(payload["data"]["payload"]["status_text"], json!("회의 중"));
        assert_eq!(
            payload["data"]["payload"]["status_expires_at_ms"],
            json!(1_700_000_000_000i64)
        );
        let key = payload["idempotency_key"].as_str().expect("key");
        assert!(key.contains("away"), "{key}");
        assert!(key.contains("회의 중"), "{key}");
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

    #[test]
    fn custom_text_trims_and_caps_at_80() {
        assert_eq!(normalize_status_text(None).expect("ok"), None);
        assert_eq!(normalize_status_text(Some("  ")).expect("ok"), None);
        assert_eq!(
            normalize_status_text(Some("  회의 중  "))
                .expect("ok")
                .as_deref(),
            Some("회의 중")
        );
        let ok = "한".repeat(STATUS_TEXT_MAX_CHARS);
        assert_eq!(
            normalize_status_text(Some(&ok)).expect("ok").as_deref(),
            Some(ok.as_str())
        );
        let too_long = "한".repeat(STATUS_TEXT_MAX_CHARS + 1);
        assert_eq!(
            normalize_status_text(Some(&too_long)).expect_err("cap"),
            CustomStatusInvalid::TextTooLong
        );
    }

    #[test]
    fn custom_emoji_is_a_length_cap_not_a_classifier() {
        assert_eq!(
            normalize_status_emoji(Some(" 📅 ")).expect("ok").as_deref(),
            Some("📅")
        );
        assert_eq!(
            normalize_status_emoji(Some("not-an-emoji"))
                .expect("ok")
                .as_deref(),
            Some("not-an-emoji")
        );
        let too_long = "👍".repeat(STATUS_EMOJI_MAX_CHARS + 1);
        assert_eq!(
            normalize_status_emoji(Some(&too_long)).expect_err("cap"),
            CustomStatusInvalid::EmojiTooLong
        );
        assert_eq!(
            normalize_status_emoji(Some("a\u{0007}b")).expect_err("ctrl"),
            CustomStatusInvalid::EmojiControl
        );
    }

    #[test]
    fn reached_expiry_is_invisible_on_read() {
        let past = Utc::now() - chrono::Duration::seconds(1);
        let future = Utc::now() + chrono::Duration::hours(1);
        let now = Utc::now();
        assert!(CustomStatus::visible_at(
            Some("📅".into()),
            Some("회의 중".into()),
            Some(past),
            now
        )
        .is_empty());
        let live =
            CustomStatus::visible_at(Some("📅".into()), Some("회의 중".into()), Some(future), now);
        assert_eq!(live.emoji.as_deref(), Some("📅"));
        assert_eq!(live.text.as_deref(), Some("회의 중"));
        assert!(CustomStatus::visible_at(None, None, Some(future), now).is_empty());
    }
}
