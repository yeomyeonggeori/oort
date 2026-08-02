//! The `momo.push.dispatch.v2` wire contract — ADR-0120 D2's content boundary,
//! expressed as a type.
//!
//! # Why this type is a closed field set
//!
//! ADR-0120 D2-A: **대화 내용이 우리 인프라를 지나지 않는다.** A self-hosted momo
//! server cannot hold Apple's APNs key (only the App Store distributor has one),
//! so every push must traverse a relay operated by someone else. The design that
//! makes that acceptable is this payload: it carries *routing identity only*, and
//! the client wakes and fetches the actual content from **its own** server
//! (iOS Notification Service Extension).
//!
//! Therefore this struct carries:
//!   * server/workspace/device/token identity + APNs env/topic — routing;
//!   * `channel_id`/`message_id` — what the NSE fetches;
//!   * `collapse_id` — the APNs dedup key *and* the 011 idempotency key;
//!   * `badge` — the server-owned unread count;
//!   * `reason`/`thread_id`/`category`/`approval_id` — grouping and action routing.
//!
//! Conversation content — message body, sender display name or handle, channel
//! name, approval summary — **MUST NEVER** be added. Adding a field here is an
//! ADR-0120 change and must be matched in
//! `scripts/verify_push_notifier.sh`'s allow-list. Two tests hold this line:
//! [`tests::dispatch_payload_is_id_only`] and
//! [`tests::dispatch_payload_has_no_content_shaped_key`].
//!
//! Parity source: `workers/NotifierWorker/.../PushRelayClient.swift:24-60`.

use serde::Serialize;
use uuid::Uuid;

/// The schema tag the relay validates and the NSE checks.
pub const DISPATCH_SCHEMA: &str = "momo.push.dispatch.v2";

/// Why a member is being notified. Judgment produces exactly these; the
/// precedence between them lives in the judgment SQL, not here.
///
/// Parity: `NotifierService.swift:363-378`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushReason {
    Dm,
    Mention,
    ApprovalRequest,
    ResumeOffer,
    WorkSessionIdle,
}

impl PushReason {
    pub fn as_str(self) -> &'static str {
        match self {
            PushReason::Dm => "dm",
            PushReason::Mention => "mention",
            PushReason::ApprovalRequest => "approval_request",
            PushReason::ResumeOffer => "resume_offer",
            PushReason::WorkSessionIdle => "work_session_idle",
        }
    }

    /// Decode the judgment SQL's `reason` column.
    pub fn from_db(raw: &str) -> Option<Self> {
        match raw {
            "dm" => Some(PushReason::Dm),
            "mention" => Some(PushReason::Mention),
            "approval_request" => Some(PushReason::ApprovalRequest),
            "resume_offer" => Some(PushReason::ResumeOffer),
            "work_session_idle" => Some(PushReason::WorkSessionIdle),
            _ => None,
        }
    }

    /// Whether the **relay** will accept this reason.
    ///
    /// Known divergence, ported deliberately rather than silently repaired:
    /// judgment can produce [`PushReason::WorkSessionIdle`]
    /// (`NotifierService.swift:367-369`), but the relay's closed validator
    /// (`relay/PushRelay/.../PushDispatch.swift:71-73`) and the iOS NSE
    /// (`clients/iOS/.../PushNotification.swift:188`) both accept only the other
    /// four. Such a dispatch is answered 400 → settled as a permanent failure →
    /// never delivered and never retried.
    ///
    /// The e2e gate does not catch this because it asserts against
    /// `scripts/mock_push_relay.py`, which performs no vocabulary validation.
    /// Widening the relay's vocabulary is an ADR-0120 wire change, so this port
    /// preserves the behaviour and pins it with
    /// [`tests::work_session_idle_is_not_deliverable_through_the_relay`].
    pub fn accepted_by_relay(self) -> bool {
        !matches!(self, PushReason::WorkSessionIdle)
    }
}

/// APNs `category` — drives the client's notification actions and grouping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushCategory {
    Message,
    Mention,
    Approval,
    Work,
}

impl PushCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            PushCategory::Message => "momo.message",
            PushCategory::Mention => "momo.mention",
            PushCategory::Approval => "momo.approval",
            PushCategory::Work => "momo.work",
        }
    }
}

/// Map one message's shape onto its APNs category.
///
/// Parity: `NotifierService.category(messageType:propsKind:reason:)`
/// (`NotifierService.swift:268-276`) — the branch order is load-bearing, since
/// a `resume_offer` is an `approval_request` message that must still group as
/// work rather than as an approval.
pub fn category_for(
    message_type: &str,
    props_kind: Option<&str>,
    reason: PushReason,
) -> PushCategory {
    if matches!(props_kind, Some("resume_offer") | Some("work_session_idle")) {
        return PushCategory::Work;
    }
    if message_type == "approval_request" {
        return PushCategory::Approval;
    }
    if props_kind == Some("work_session") {
        return PushCategory::Work;
    }
    if reason == PushReason::Mention {
        return PushCategory::Mention;
    }
    PushCategory::Message
}

/// The APNs collapse id for one message.
///
/// Stable across redeliveries (it is the 011 dedupe index key) and within the
/// 64-byte `apns-collapse-id` header limit: `"m:"` + a 36-char UUID = 38 bytes.
///
/// Parity: `NotifierService.collapseID(for:)` (`NotifierService.swift:264-266`).
pub fn collapse_id(message_id: Uuid) -> String {
    format!("m:{}", hyphenated_lower(message_id))
}

/// Every id on this wire is lowercase hyphenated, matching Swift's
/// `uuidString.lowercased()`.
pub(crate) fn hyphenated_lower(id: Uuid) -> String {
    id.hyphenated().to_string()
}

/// The id-only payload posted to the push relay.
///
/// Field order and names are byte-parity with the Swift encoder, so
/// `scripts/verify_push_notifier.sh`'s allow-list check passes unchanged.
/// `approval_id` is omitted (not `null`) when absent, because Swift's
/// synthesized `Encodable` uses `encodeIfPresent` and the relay's
/// `decodeClosed` compares the *key set* exactly.
#[derive(Debug, Clone, Serialize)]
pub struct PushDispatch {
    pub schema: &'static str,
    pub server_id: String,
    pub workspace_id: String,
    pub device_id: String,
    pub device_platform: String,
    pub apns_token: String,
    pub apns_env: String,
    pub apns_topic: String,
    pub collapse_id: String,
    pub badge: i64,
    pub reason: &'static str,
    pub thread_id: String,
    pub category: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    pub channel_id: String,
    pub message_id: String,
}

/// Everything needed to build one dispatch. A struct rather than 14 positional
/// arguments so a future field cannot silently land in the wrong slot.
#[derive(Debug, Clone)]
pub struct DispatchTarget {
    pub server_id: String,
    pub workspace_id: Uuid,
    pub device_id: Uuid,
    pub device_platform: String,
    pub apns_token: String,
    pub apns_env: String,
    pub apns_topic: String,
    pub collapse_id: String,
    pub badge: i64,
    pub reason: PushReason,
    pub thread_id: Uuid,
    pub category: PushCategory,
    pub approval_id: Option<Uuid>,
    pub channel_id: Uuid,
    pub message_id: Uuid,
}

impl PushDispatch {
    /// Build the wire payload.
    ///
    /// Note what this constructor does **not** take: no body, no display name,
    /// no channel name. There is no way to place conversation content on this
    /// wire without changing the type — which is the point.
    pub fn new(target: &DispatchTarget) -> Self {
        // An approval id is meaningful only for the approval category; the relay
        // rejects the pair otherwise (`PushDispatch.swift:76-80`), and so does
        // the NSE.
        let approval_id = if target.category == PushCategory::Approval {
            target.approval_id.map(hyphenated_lower)
        } else {
            None
        };
        PushDispatch {
            schema: DISPATCH_SCHEMA,
            server_id: target.server_id.clone(),
            workspace_id: hyphenated_lower(target.workspace_id),
            device_id: hyphenated_lower(target.device_id),
            device_platform: target.device_platform.clone(),
            apns_token: target.apns_token.clone(),
            apns_env: target.apns_env.clone(),
            apns_topic: target.apns_topic.clone(),
            collapse_id: target.collapse_id.clone(),
            badge: target.badge,
            reason: target.reason.as_str(),
            thread_id: hyphenated_lower(target.thread_id),
            category: target.category.as_str(),
            approval_id,
            channel_id: hyphenated_lower(target.channel_id),
            message_id: hyphenated_lower(target.message_id),
        }
    }
}

/// The outcome of one dispatch attempt.
///
/// Parity: `PushRelayClient.DispatchResult` (`PushRelayClient.swift:78-82`) and
/// its HTTP classification at `:106-111`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    /// The relay accepted and returned an APNs receipt. Settled verbatim.
    Accepted {
        apns_status: i32,
        apns_reason: Option<String>,
    },
    /// The relay itself refused in a way retrying cannot fix (4xx other than
    /// 429). Settled with the **relay's real HTTP status** and a `relay_http:`
    /// prefixed reason, so a later token-invalidation pass can never mistake a
    /// relay-level 400 for a genuine APNs `BadDeviceToken` and revoke healthy
    /// tokens (review #424 M1).
    PermanentFailure {
        relay_http_status: i32,
        reason: String,
    },
    /// 429/5xx or a transport error — the candidate is requeued with backoff.
    TransientFailure(String),
}

/// The transport seam.
///
/// The notifier calls this; the conformance tests replace it. Production wires
/// an Ed25519-signing HTTP client to the relay, so a test and production route
/// identically. Real APNs delivery happens *beyond* the relay and is never
/// exercised from this repo's tests.
#[async_trait::async_trait]
pub trait PushDispatcher: Send + Sync {
    async fn dispatch(&self, dispatch: &PushDispatch) -> DispatchOutcome;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_target() -> DispatchTarget {
        DispatchTarget {
            server_id: "momo-test".to_string(),
            workspace_id: Uuid::parse_str("00000000-0000-7000-8000-000000000001").unwrap(),
            device_id: Uuid::parse_str("00000000-0000-7000-8000-0000000000d1").unwrap(),
            device_platform: "ios".to_string(),
            apns_token: "ab".repeat(32),
            apns_env: "sandbox".to_string(),
            apns_topic: "kim.dawn.momo.e2e".to_string(),
            collapse_id: collapse_id(
                Uuid::parse_str("00000000-0000-7000-8000-000000000301").unwrap(),
            ),
            badge: 3,
            reason: PushReason::Dm,
            thread_id: Uuid::parse_str("00000000-0000-7000-8000-000000000201").unwrap(),
            category: PushCategory::Message,
            approval_id: None,
            channel_id: Uuid::parse_str("00000000-0000-7000-8000-000000000201").unwrap(),
            message_id: Uuid::parse_str("00000000-0000-7000-8000-000000000301").unwrap(),
        }
    }

    /// ADR-0120 D2 build-time guard, and the reason this whole design exists.
    ///
    /// The relay-bound payload must carry **exactly** the id-only routing field
    /// set. Revert that — add a `body`, a `sender_name`, a `channel_name` — and
    /// this goes red. It mirrors `scripts/verify_push_notifier.sh:596-617`,
    /// which asserts the same allow-list at runtime, and the Swift unit test
    /// `NotifierWorkerTests.testDispatchPayloadIsIdOnly`.
    #[test]
    fn dispatch_payload_is_id_only() {
        let dispatch = PushDispatch::new(&sample_target());
        let value = serde_json::to_value(&dispatch).expect("serialize dispatch");
        let object = value.as_object().expect("dispatch is a JSON object");

        let allowed: std::collections::BTreeSet<&str> = [
            "schema",
            "server_id",
            "workspace_id",
            "device_id",
            "device_platform",
            "apns_token",
            "apns_env",
            "apns_topic",
            "collapse_id",
            "badge",
            "reason",
            "thread_id",
            "category",
            "channel_id",
            "message_id",
        ]
        .into_iter()
        .collect();

        let actual: std::collections::BTreeSet<&str> = object.keys().map(String::as_str).collect();

        assert_eq!(
            actual, allowed,
            "the id-only dispatch field set changed — this is an ADR-0120 D2 \
             boundary change and must also update scripts/verify_push_notifier.sh"
        );
        assert_eq!(object["schema"], serde_json::json!(DISPATCH_SCHEMA));
    }

    /// Defence in depth against the *shape* of a leak, not just today's names:
    /// no key may even resemble a content-bearing field. A future `preview_text`
    /// or `sender_handle` trips this even if someone also edits the allow-list
    /// above.
    #[test]
    fn dispatch_payload_has_no_content_shaped_key() {
        let dispatch = PushDispatch::new(&sample_target());
        let value = serde_json::to_value(&dispatch).expect("serialize dispatch");
        let object = value.as_object().expect("dispatch is a JSON object");

        for key in object.keys() {
            for fragment in [
                "body",
                "text",
                "name",
                "handle",
                "summary",
                "title",
                "preview",
                "content",
                "message_body",
                "author",
                "sender",
                "excerpt",
                "snippet",
            ] {
                assert!(
                    !key.to_ascii_lowercase().contains(fragment),
                    "content-shaped key '{key}' violates the id-only contract (ADR-0120 D2)"
                );
            }
        }
    }

    /// The payload must never carry the conversation itself even when the
    /// surrounding message is full of it. Serializing cannot reach message text,
    /// so we assert the rendered JSON is free of content the caller knows.
    #[test]
    fn dispatch_payload_cannot_carry_message_content() {
        let dispatch = PushDispatch::new(&sample_target());
        let json = serde_json::to_string(&dispatch).expect("serialize dispatch");

        for secret in [
            "hello world",
            "김성재",
            "Review before running",
            "@intern",
            "general",
        ] {
            assert!(
                !json.contains(secret),
                "conversation content '{secret}' reached the relay payload"
            );
        }
    }

    #[test]
    fn approval_id_rides_only_with_the_approval_category() {
        let approval = Uuid::parse_str("00000000-0000-7000-8000-000000000401").unwrap();

        let mut target = sample_target();
        target.approval_id = Some(approval);
        target.category = PushCategory::Message;
        let without = PushDispatch::new(&target);
        assert!(
            without.approval_id.is_none(),
            "a non-approval category must not carry an approval id — the relay \
             rejects the pair (PushDispatch.swift:76-80)"
        );
        let json = serde_json::to_value(&without).unwrap();
        assert!(
            !json.as_object().unwrap().contains_key("approval_id"),
            "absent approval_id must be omitted, not null"
        );

        target.category = PushCategory::Approval;
        target.reason = PushReason::ApprovalRequest;
        let with = PushDispatch::new(&target);
        assert_eq!(
            with.approval_id.as_deref(),
            Some(approval.hyphenated().to_string().as_str())
        );
    }

    /// Parity with `NotifierWorkerTests.testPayloadCategoriesPreserveJudgmentPrecedence`.
    #[test]
    fn category_precedence_matches_swift() {
        assert_eq!(
            category_for("text", None, PushReason::Dm),
            PushCategory::Message
        );
        assert_eq!(
            category_for("text", None, PushReason::Mention),
            PushCategory::Mention
        );
        assert_eq!(
            category_for(
                "approval_request",
                Some("work_control_approval"),
                PushReason::ApprovalRequest
            ),
            PushCategory::Approval
        );
        assert_eq!(
            category_for("system", Some("work_session"), PushReason::Dm),
            PushCategory::Work
        );
        assert_eq!(
            category_for(
                "approval_request",
                Some("resume_offer"),
                PushReason::ResumeOffer
            ),
            PushCategory::Work,
            "a resume offer is an approval_request message that must still group as work"
        );
        assert_eq!(
            category_for(
                "system",
                Some("work_session_idle"),
                PushReason::WorkSessionIdle
            ),
            PushCategory::Work
        );
    }

    /// Parity with `NotifierWorkerTests.testCollapseIDIsStableAndWithinAPNsLimit`.
    #[test]
    fn collapse_id_is_stable_and_within_the_apns_header_limit() {
        let message_id = Uuid::parse_str("0198f0a2-1234-7abc-8def-0123456789ab").unwrap();
        let first = collapse_id(message_id);
        let second = collapse_id(message_id);
        assert_eq!(
            first, second,
            "collapse id must be deterministic per message"
        );
        assert_eq!(first, "m:0198f0a2-1234-7abc-8def-0123456789ab");
        assert!(first.len() <= 64, "apns-collapse-id is capped at 64 bytes");
    }

    /// Pins the divergence documented on [`PushReason::accepted_by_relay`]:
    /// judgment can emit `work_session_idle`, but the relay and the iOS NSE
    /// accept only four reasons, so those pushes are silently undeliverable
    /// today. If the relay's vocabulary is ever widened (an ADR-0120 change),
    /// this test goes red and must be updated deliberately.
    #[test]
    fn work_session_idle_is_not_deliverable_through_the_relay() {
        for reason in [
            PushReason::Dm,
            PushReason::Mention,
            PushReason::ApprovalRequest,
            PushReason::ResumeOffer,
        ] {
            assert!(
                reason.accepted_by_relay(),
                "{} is in the relay vocabulary",
                reason.as_str()
            );
        }
        assert!(
            !PushReason::WorkSessionIdle.accepted_by_relay(),
            "relay/PushRelay/.../PushDispatch.swift:71-73 rejects work_session_idle"
        );
    }
}
