//! Why a hosted agent did not answer, said where the caller can see it (#2871).
//!
//! A mention, a 1:1 DM or a mention inside a thread that reaches a **hosted**
//! (Agent Port) agent can be refused by the server before any job exists:
//!
//! | reason (`agent.mention.skipped`) | what is true |
//! |---|---|
//! | `hosted_delivery_not_enabled` | this server does not deliver to hosted runtimes at all (`MOMO_HOSTED_DELIVERY_ENABLED` closed) |
//! | `hosted_connection_unavailable` | the agent has no active connection |
//! | `hosted_channel_unapproved` | the connection was never approved for this conversation |
//!
//! Until #2871 each of these ended in an audit row and nothing else, so from
//! the timeline "the agent ignored me" and "the server never asked it" looked
//! identical (RCA 2026-09-27 1-d). This module owns the sentence for each
//! reason and the props the throttle reads back; the route composes the write.
//!
//! ## Shape — the paused line's, not ADR-0193's
//!
//! These are **server** facts about delivery, not something the agent says,
//! so the line is `type = 'system'` (like `paused_mention_body`), not an
//! agent-voiced text message (ADR-0193 D4 refuses a server line imitating the
//! agent's voice; this line speaks *about* the agent, in the third person).
//! The write goes through the single message path — `channel_seq` bump +
//! `message` INSERT + broadcast outbox INSERT — in the send's own transaction.
//!
//! ## Throttle — same thread, same person, same reason, ten minutes
//!
//! In a 1:1 DM every utterance addresses the agent, so without a throttle five
//! messages would stack five identical lines. The key and window are
//! ADR-0193's (`SUBSCRIPTION_NOTICE_THROTTLE_SECONDS`), keyed per reason so a
//! *different* problem is still told at once.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::korean::{attach_particle, ParticlePair};

/// `message.props.source` of every hosted skip line.
pub const HOSTED_SKIP_NOTICE_SOURCE: &str = "server.hosted_agent.notice.v1";
/// `message.props.kind` — one value for all reasons; `props.reason` says which.
pub const HOSTED_SKIP_NOTICE_KIND: &str = "agent_hosted_skip";
/// Same window as ADR-0193's notices.
pub const HOSTED_SKIP_NOTICE_THROTTLE_SECONDS: i64 = crate::SUBSCRIPTION_NOTICE_THROTTLE_SECONDS;

pub const HOSTED_SKIP_NOTICE_POSTED_ACTION: &str = "agent.hosted_skip.notice_posted";
pub const HOSTED_SKIP_NOTICE_THROTTLED_ACTION: &str = "agent.hosted_skip.notice_throttled";
pub const HOSTED_SKIP_NOTICE_AUDIT_SCHEMA: &str = "momo.agent.hosted_skip_notice.v1";

/// The operator guide for the delivery gate. Public repository, so a member
/// who is not the operator can hand the link on.
pub const HOSTED_DELIVERY_GUIDE_URL: &str =
    "https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST.md#hosted-agent-agent-port-on-self-host";

/// The in-app door for the two reasons a workspace admin can fix: approving a
/// conversation and reconnecting both live on 설정 › 연결 › 에이전트 자격.
pub const HOSTED_SKIP_ACTION_HREF: &str = "/settings?section=agents";
pub const HOSTED_SKIP_ACTION_LABEL: &str = "에이전트 자격 열기";

/// The three hosted skip reasons that get a visible line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedSkipReason {
    DeliveryNotEnabled,
    ConnectionUnavailable,
    ChannelUnapproved,
}

impl HostedSkipReason {
    /// The wire string — identical to the `agent.mention.skipped` audit reason,
    /// so one word answers "what happened to this @mention" in both places.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeliveryNotEnabled => "hosted_delivery_not_enabled",
            Self::ConnectionUnavailable => "hosted_connection_unavailable",
            Self::ChannelUnapproved => "hosted_channel_unapproved",
        }
    }

    /// The in-app fix, when there is one. The delivery gate is an operator
    /// setting outside the app, so its path is the guide link in the body.
    pub fn action(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::DeliveryNotEnabled => None,
            Self::ConnectionUnavailable | Self::ChannelUnapproved => {
                Some((HOSTED_SKIP_ACTION_LABEL, HOSTED_SKIP_ACTION_HREF))
            }
        }
    }
}

/// The sentence (해요체, with the way out).
pub fn hosted_skip_notice_body(reason: HostedSkipReason, agent_display_name: &str) -> String {
    match reason {
        HostedSkipReason::DeliveryNotEnabled => format!(
            // 「에게」 does not change with the final consonant.
            "{agent_display_name}에게 메시지를 전달하지 못했어요. 이 서버에서 외부 에이전트 전달이 꺼져 있어요. \
             서버 관리자에게 [켜는 방법]({HOSTED_DELIVERY_GUIDE_URL})을 전해 주세요."
        ),
        HostedSkipReason::ConnectionUnavailable => format!(
            // 「의」 does not change with the final consonant either.
            "{agent_display_name}의 연결이 끊겨 있어서 답하지 못했어요. 설정 › 에이전트 자격에서 다시 연결해 주세요."
        ),
        HostedSkipReason::ChannelUnapproved => format!(
            "{} 이 대화에서 답하도록 승인되지 않았어요. 설정 › 에이전트 자격에서 이 대화를 승인해 주세요.",
            attach_particle(agent_display_name, ParticlePair::Topic)
        ),
    }
}

/// `message.props` of a hosted skip line. The throttle reads `source`,
/// `reason`, `notice_for_member_id` and `notice_thread_key` back.
pub fn hosted_skip_notice_props(
    reason: HostedSkipReason,
    agent_member_id: Uuid,
    recipient_member_id: Uuid,
    thread_key: Uuid,
    trigger_message_id: Uuid,
) -> Value {
    let mut props = json!({
        "source": HOSTED_SKIP_NOTICE_SOURCE,
        "kind": HOSTED_SKIP_NOTICE_KIND,
        "reason": reason.as_str(),
        "agent_member_id": agent_member_id.to_string(),
        "notice_for_member_id": recipient_member_id,
        "notice_thread_key": thread_key,
        "trigger_message_id": trigger_message_id,
    });
    if let (Some((label, href)), Some(object)) = (reason.action(), props.as_object_mut()) {
        object.insert(
            "notice_action".into(),
            json!({ "label": label, "href": href }),
        );
    }
    props
}

/// The advisory-lock key for one throttle decision.
pub fn hosted_skip_notice_key(
    agent_member_id: Uuid,
    channel_id: Uuid,
    thread_key: Uuid,
    recipient_member_id: Uuid,
    reason: HostedSkipReason,
) -> String {
    format!(
        "hosted_skip_notice:{agent_member_id}:{channel_id}:{thread_key}:{recipient_member_id}:{}",
        reason.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reason_says_what_happened_and_where_to_fix_it() {
        assert_eq!(
            hosted_skip_notice_body(HostedSkipReason::DeliveryNotEnabled, "루나"),
            format!(
                "루나에게 메시지를 전달하지 못했어요. 이 서버에서 외부 에이전트 전달이 꺼져 있어요. \
                 서버 관리자에게 [켜는 방법]({HOSTED_DELIVERY_GUIDE_URL})을 전해 주세요."
            )
        );
        assert_eq!(
            hosted_skip_notice_body(HostedSkipReason::ConnectionUnavailable, "Claude Code"),
            "Claude Code의 연결이 끊겨 있어서 답하지 못했어요. 설정 › 에이전트 자격에서 다시 연결해 주세요."
        );
        assert_eq!(
            hosted_skip_notice_body(HostedSkipReason::ChannelUnapproved, "김인턴"),
            "김인턴은 이 대화에서 답하도록 승인되지 않았어요. 설정 › 에이전트 자격에서 이 대화를 승인해 주세요."
        );
    }

    #[test]
    fn the_reason_word_is_the_audit_word_and_only_fixable_reasons_carry_a_door() {
        assert_eq!(
            HostedSkipReason::DeliveryNotEnabled.as_str(),
            "hosted_delivery_not_enabled"
        );
        let props = hosted_skip_notice_props(
            HostedSkipReason::ChannelUnapproved,
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            Uuid::from_u128(4),
        );
        assert_eq!(props["kind"], HOSTED_SKIP_NOTICE_KIND);
        assert_eq!(props["reason"], "hosted_channel_unapproved");
        assert_eq!(props["notice_action"]["href"], "/settings?section=agents");
        let gate = hosted_skip_notice_props(
            HostedSkipReason::DeliveryNotEnabled,
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            Uuid::from_u128(4),
        );
        assert!(gate.get("notice_action").is_none());
    }

    #[test]
    fn each_reason_throttles_on_its_own_key() {
        let a = Uuid::from_u128(1);
        let keys: Vec<String> = [
            HostedSkipReason::DeliveryNotEnabled,
            HostedSkipReason::ConnectionUnavailable,
            HostedSkipReason::ChannelUnapproved,
        ]
        .into_iter()
        .map(|reason| hosted_skip_notice_key(a, a, a, a, reason))
        .collect();
        let mut unique = keys.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 3);
    }
}
