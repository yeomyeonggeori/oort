//! The delivery half of a push that names no message (ADR-0206 D15, #4341) — the test
//! notification a member sends to their own devices.
//!
//! A `push_candidate` points at a message and its judgment reads that message; a push with no
//! message cannot run through it. This module is what the notifier's second drain
//! (`kind = 'push_system'`, [`momo_outbox::claim_push_system_batch`]) calls instead:
//!
//! * [`system_targets`] — the member's active tokens (the most recent [`SYSTEM_PUSH_MAX_TARGETS`]
//!   of them), and nobody else's;
//! * [`system_dispatch_target`] — the id-only envelope with the **nil-UUID sentinel** for every id
//!   the push does not have (the relay checks the fields are non-empty and does not look them up);
//! * [`test_notification_collapse_id`] — `t:<test id>`, the key the dispatch log is claimed by and
//!   the diagnostics read the result by.
//!
//! There is deliberately **no judgment here**: no pause, no channel mute, no kind switch is read.
//! The test's question is "does the delivery path work", and the gates are what the diagnostics
//! `GET` reports (ADR-0206 D11). What keeps that from being a way to push strangers is the shape of
//! this module: [`system_targets`] takes one `member_id` and has no other way to choose a token.
//!
//! What keeps it from being a way to flood the relay is [`SYSTEM_PUSH_MAX_TARGETS`]: a push with no
//! message has nothing else to bound it, and the number of devices is the requester's to choose
//! (registering one costs nothing), so one `push_system` row is capped at that many relay calls.

use momo_db::DbError;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use crate::dispatch::{hyphenated_lower, DispatchTarget, PushCategory, PushReason};

/// The collapse id of one test notification: `t:<test id>` (ADR-0206 D15) — 38 bytes, under the 64
/// the APNs header and the relay allow. The route writes it into the `push_system` payload, the
/// notifier claims the dispatch log by it, and the diagnostics read the test's result by it, so it
/// has exactly one spelling.
pub fn test_notification_collapse_id(test_id: Uuid) -> String {
    format!("t:{}", hyphenated_lower(test_id))
}

/// One active push token of the member a system push is for.
#[derive(Debug, Clone)]
pub struct SystemTarget {
    pub token_id: Uuid,
    pub device_id: Uuid,
    pub device_platform: String,
    pub apns_token: String,
    pub apns_env: String,
    pub apns_topic: String,
}

/// The most devices **one system push** reaches (#4341 security review H-1).
///
/// A test notification used to go to every active token of the member, so one `POST` made as many
/// relay calls as the member had devices — and nothing limits how many a member registers. The relay
/// answers 429 past its server-wide budget (60 a minute by default) and a regular push that meets a
/// 429 retries for about three minutes and then gives up, so one member with enough devices could
/// push other people's pushes out. With this cap the product is at most
/// `SYSTEM_PUSH_MAX_TARGETS × TEST_PUSH_PER_WINDOW` = 15 relay calls per member per minute.
///
/// The devices kept are the **most recently registered or refreshed** (`push_token.updated_at`: a
/// registration sets it and a re-registration of the same token refreshes it). It is one
/// constant on purpose: [`system_targets`] applies it to the delivery and
/// [`crate::reserve_test_push_in_tx`] applies it to the `deviceCount` it reports, so the number the
/// person is told is the number of devices the push goes to. The diagnostics' `devices.active` stays
/// the member's real count. Every `push_system` reason shares it (a later producer such as ADR-0208's
/// failed-schedule push inherits the cap and may raise it by its own ADR).
pub const SYSTEM_PUSH_MAX_TARGETS: i64 = 5;

/// The active tokens of **one** member, in the tenant the transaction is bound to — the most recent
/// [`SYSTEM_PUSH_MAX_TARGETS`] of them, newest first.
///
/// "Active" is the judgment's definition of a token that can receive a push: `invalidated_at IS
/// NULL`, on a `device` of this workspace, owned by a member who is an active, undeleted human.
/// Every predicate names `workspace_id` and `member_id` — the notifier's pool is BYPASSRLS, so the
/// GUC is not what keeps this off another tenant's tokens.
pub async fn system_targets(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Vec<SystemTarget>, DbError> {
    let rows = sqlx::query(
        "SELECT t.id AS token_id, \
                d.id AS device_id, \
                d.platform::text AS platform, \
                t.apns_token, \
                t.env::text AS env, \
                t.topic \
           FROM push_token t \
           JOIN device d \
             ON d.id = t.device_id \
            AND d.workspace_id = $1 \
           JOIN member mem \
             ON mem.id = t.member_id \
            AND mem.workspace_id = $1 \
            AND mem.status = 'active' \
            AND mem.deleted_at IS NULL \
            AND mem.kind = 'human' \
          WHERE t.workspace_id = $1 \
            AND t.member_id = $2 \
            AND t.invalidated_at IS NULL \
          ORDER BY t.updated_at DESC, t.id DESC \
          LIMIT $3",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(SYSTEM_PUSH_MAX_TARGETS)
    .fetch_all(&mut *conn)
    .await?;
    let mut targets = Vec::with_capacity(rows.len());
    for row in rows {
        targets.push(SystemTarget {
            token_id: row.try_get("token_id")?,
            device_id: row.try_get("device_id")?,
            device_platform: row.try_get("platform")?,
            apns_token: row.try_get("apns_token")?,
            apns_env: row.try_get("env")?,
            apns_topic: row.try_get("topic")?,
        });
    }
    Ok(targets)
}

/// What one system push says, apart from who it goes to: the reason and category on the wire,
/// the channel it is about (if any), the collapse id the producer chose and the badge.
#[derive(Debug, Clone)]
pub struct SystemPush<'a> {
    pub reason: PushReason,
    pub category: PushCategory,
    pub channel_id: Option<Uuid>,
    pub collapse_id: &'a str,
    /// The member's real unread count, **not 0**: a badge of 0 on this alert would clear the app
    /// icon's badge as a side effect of pressing 「시험 알림」.
    pub badge: i64,
}

/// Build the dispatch for one target of a system push.
///
/// Every id the push does not have is the nil UUID: `message_id` always (a system push names no
/// message), and `channel_id` / `thread_id` unless the push is about a channel (then both are that
/// channel, the way a plain channel message's are). The test notification has no channel, so all
/// three are nil — which the relay accepts (it checks "not empty", and UUID shape only for
/// `approval_id`) and which the Swift parser accepts (a nil UUID is a valid UUID).
pub fn system_dispatch_target(
    server_id: &str,
    workspace_id: Uuid,
    target: &SystemTarget,
    push: &SystemPush<'_>,
) -> DispatchTarget {
    let channel = push.channel_id.unwrap_or_else(Uuid::nil);
    DispatchTarget {
        server_id: server_id.to_string(),
        workspace_id,
        device_id: target.device_id,
        device_platform: target.device_platform.clone(),
        apns_token: target.apns_token.clone(),
        apns_env: target.apns_env.clone(),
        apns_topic: target.apns_topic.clone(),
        collapse_id: push.collapse_id.to_string(),
        badge: push.badge,
        reason: push.reason,
        thread_id: channel,
        category: push.category,
        approval_id: None,
        channel_id: channel,
        message_id: Uuid::nil(),
    }
}

/// The dispatch of one test notification (`test_notification` under `momo.system`, no channel).
pub fn test_notification_dispatch_target(
    server_id: &str,
    workspace_id: Uuid,
    target: &SystemTarget,
    collapse_id: &str,
    badge: i64,
) -> DispatchTarget {
    system_dispatch_target(
        server_id,
        workspace_id,
        target,
        &SystemPush {
            reason: PushReason::TestNotification,
            category: PushCategory::System,
            channel_id: None,
            collapse_id,
            badge,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::PushDispatch;

    fn target() -> SystemTarget {
        SystemTarget {
            token_id: Uuid::from_u128(0x10),
            device_id: Uuid::from_u128(0x20),
            device_platform: "ios".to_string(),
            apns_token: "deadbeefdeadbeefdeadbeefdeadbeef".to_string(),
            apns_env: "sandbox".to_string(),
            apns_topic: "app.momo.ios".to_string(),
        }
    }

    /// ADR-0206 D15: one spelling, 38 bytes, a prefix no message collapse id (`m:`), approval
    /// settlement (`as:`) or bulk representative (`o:`) shares.
    #[test]
    fn the_test_collapse_id_is_t_prefix_plus_the_test_id() {
        let id = Uuid::parse_str("0198f0a2-1234-7abc-8def-0123456789ab").unwrap();
        let collapse = test_notification_collapse_id(id);
        assert_eq!(collapse, "t:0198f0a2-1234-7abc-8def-0123456789ab");
        assert_eq!(collapse.len(), 38);
        assert!(
            collapse.len() <= 64,
            "apns-collapse-id is capped at 64 bytes"
        );
        assert_ne!(
            collapse,
            crate::dispatch::collapse_id(id),
            "a test must never share a dispatch-log key with a message push"
        );
    }

    /// The envelope of a test notification: `test_notification` under `momo.system`, the nil-UUID
    /// sentinel for the channel, message and thread, no `approval_id`, and the member's real badge.
    #[test]
    fn a_test_notification_dispatch_uses_the_nil_sentinel_and_the_system_category() {
        let workspace = Uuid::from_u128(0x01);
        let dispatch = PushDispatch::new(&test_notification_dispatch_target(
            "momo-test",
            workspace,
            &target(),
            "t:abc",
            7,
        ));
        let value = serde_json::to_value(&dispatch).expect("serialize");
        let nil = "00000000-0000-0000-0000-000000000000";
        assert_eq!(value["reason"], "test_notification");
        assert_eq!(value["category"], "momo.system");
        assert_eq!(value["channel_id"], nil);
        assert_eq!(value["message_id"], nil);
        assert_eq!(value["thread_id"], nil);
        assert_eq!(value["collapse_id"], "t:abc");
        assert_eq!(
            value["badge"], 7,
            "the badge is the unread count, never a reset to 0"
        );
        assert!(
            value.get("approval_id").is_none(),
            "only the two approval categories carry an approval id"
        );
    }

    /// A system push about a channel puts that channel on both the channel and the thread id (as a
    /// plain channel message does) and still names no message.
    #[test]
    fn a_channel_system_push_keeps_the_message_nil() {
        let channel = Uuid::from_u128(0xc0);
        let built = system_dispatch_target(
            "momo-test",
            Uuid::from_u128(0x01),
            &target(),
            &SystemPush {
                reason: PushReason::TestNotification,
                category: PushCategory::System,
                channel_id: Some(channel),
                collapse_id: "s:x:1",
                badge: 0,
            },
        );
        assert_eq!(built.channel_id, channel);
        assert_eq!(built.thread_id, channel);
        assert_eq!(built.message_id, Uuid::nil());
    }
}
