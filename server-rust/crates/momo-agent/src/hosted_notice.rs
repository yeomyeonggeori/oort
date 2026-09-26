//! Why a hosted agent did not answer, said where the caller can see it (#2871).
//!
//! A mention, a 1:1 DM or a mention inside a thread that reaches a **hosted**
//! (Agent Port) agent can be refused by the server before any job exists:
//!
//! | reason (`agent.mention.skipped`) | what is true |
//! |---|---|
//! | `hosted_delivery_not_enabled` | this server does not deliver to hosted runtimes at all (`MOMO_HOSTED_DELIVERY_ENABLED` closed) |
//! | `hosted_connection_unavailable` | the agent has no active connection |
//! | `hosted_channel_unapproved` | the connection was never approved for this channel; in a 1:1 DM it never can be (`kind <> 'dm'`), so the line there says so instead (`hosted_dm_not_approvable`) |
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
    /// `hosted_channel_unapproved` said inside a 1:1 DM. Approval takes
    /// channels only, so "approve this room" would be false there.
    DirectMessageNotApprovable,
}

impl HostedSkipReason {
    /// The wire string. Identical to the `agent.mention.skipped` audit reason,
    /// except the DM case, which the audit records as
    /// `hosted_channel_unapproved` (the gate that refused it) and the line
    /// names by what the reader can do about it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeliveryNotEnabled => "hosted_delivery_not_enabled",
            Self::ConnectionUnavailable => "hosted_connection_unavailable",
            Self::ChannelUnapproved => "hosted_channel_unapproved",
            Self::DirectMessageNotApprovable => "hosted_dm_not_approvable",
        }
    }

    /// The in-app fix, when there is one. The delivery gate is an operator
    /// setting outside the app, so its path is the guide link in the body.
    pub fn action(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::DeliveryNotEnabled | Self::DirectMessageNotApprovable => None,
            Self::ConnectionUnavailable | Self::ChannelUnapproved => {
                Some((HOSTED_SKIP_ACTION_LABEL, HOSTED_SKIP_ACTION_HREF))
            }
        }
    }
}

/// The sentence (해요체, with the way out).
///
/// The line is visible to everyone in the room, and only a workspace owner or
/// admin can open 에이전트 자격, so the two fixable reasons say who can fix
/// it rather than telling every reader to. The agent's name is never followed
/// by a topic/subject particle: 「에게」 and 「의」 do not change with the
/// final consonant, so a Latin name reads cleanly without the 「은(는)」 hedge.
pub fn hosted_skip_notice_body(reason: HostedSkipReason, agent_display_name: &str) -> String {
    let inert = inert_display_name(agent_display_name);
    let agent_display_name = inert.as_str();
    match reason {
        HostedSkipReason::DeliveryNotEnabled => format!(
            "{agent_display_name}에게 메시지를 전달하지 못했어요. 이 서버에서 외부 에이전트 전달이 꺼져 있어요. \
             서버 관리자에게 [켜는 방법]({HOSTED_DELIVERY_GUIDE_URL})을 전해 주세요."
        ),
        HostedSkipReason::ConnectionUnavailable => format!(
            "{agent_display_name}의 연결이 끊겨 있어서 답하지 못했어요. \
             워크스페이스 관리자가 설정 › 연결 › 에이전트 자격에서 다시 연결할 수 있어요."
        ),
        HostedSkipReason::ChannelUnapproved => format!(
            "이 채널은 아직 {agent_display_name}에게 승인되지 않아서 전달하지 못했어요. \
             워크스페이스 관리자가 설정 › 연결 › 에이전트 자격에서 이 채널을 승인할 수 있어요."
        ),
        HostedSkipReason::DirectMessageNotApprovable => format!(
            "1:1 대화는 {agent_display_name}에게 전달되지 않아요. 외부 에이전트는 승인된 채널에서 불러 주세요."
        ),
    }
}

/// A display name made unable to become markup in the clients' renderer
/// (security review Medium-3, #2889).
///
/// The body is parsed by `momo-core` `markdown.ts` on web and phone. That
/// parser has **no backslash escape**, so escaping is not an option; instead
/// the two constructs that produce a link are made impossible to form:
/// `[label](href)` needs ASCII brackets (swapped for their fullwidth forms),
/// and a bare link needs `http(s)://` (the colon becomes fullwidth). A backtick
/// could open a code span that swallows the guide link after it, so it is
/// swapped too. An ordinary name contains none of these and is unchanged.
pub fn inert_display_name(name: &str) -> String {
    name.replace('[', "［")
        .replace(']', "］")
        .replace('`', "｀")
        .replace("://", "：//")
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
            "Claude Code의 연결이 끊겨 있어서 답하지 못했어요. \
             워크스페이스 관리자가 설정 › 연결 › 에이전트 자격에서 다시 연결할 수 있어요."
        );
        assert_eq!(
            hosted_skip_notice_body(HostedSkipReason::ChannelUnapproved, "hermes"),
            "이 채널은 아직 hermes에게 승인되지 않아서 전달하지 못했어요. \
             워크스페이스 관리자가 설정 › 연결 › 에이전트 자격에서 이 채널을 승인할 수 있어요."
        );
        assert_eq!(
            hosted_skip_notice_body(HostedSkipReason::DirectMessageNotApprovable, "Claude Code"),
            "1:1 대화는 Claude Code에게 전달되지 않아요. 외부 에이전트는 승인된 채널에서 불러 주세요."
        );
        for reason in [
            HostedSkipReason::DeliveryNotEnabled,
            HostedSkipReason::ConnectionUnavailable,
            HostedSkipReason::ChannelUnapproved,
            HostedSkipReason::DirectMessageNotApprovable,
        ] {
            assert!(
                !hosted_skip_notice_body(reason, "hermes").contains("(는)"),
                "no particle hedge after a Latin name"
            );
        }
    }

    /// Security review Medium-3 (#2889): the body is rendered as markdown, and
    /// whoever names an agent must not be able to plant a link inside a
    /// server-voiced line. The only link a body may carry is the guide's.
    #[test]
    fn an_agent_name_cannot_plant_a_link_in_the_server_line() {
        for name in [
            "[보안 재인증](https://evil.example)",
            "https://evil.example/login",
            "HTTP://evil.example",
            "[x](http://evil.example)",
        ] {
            for reason in [
                HostedSkipReason::DeliveryNotEnabled,
                HostedSkipReason::ConnectionUnavailable,
                HostedSkipReason::ChannelUnapproved,
                HostedSkipReason::DirectMessageNotApprovable,
            ] {
                let body = hosted_skip_notice_body(reason, name);
                let lower = body.to_lowercase();
                assert!(!lower.contains("://evil"), "bare url survives: {body}");
                let without_guide =
                    body.replace(&format!("[켜는 방법]({HOSTED_DELIVERY_GUIDE_URL})"), "");
                assert!(
                    !without_guide.contains("]("),
                    "link syntax survives: {body}"
                );
                assert!(!without_guide.contains('['), "{body}");
            }
        }
        // An ordinary name is left exactly as typed.
        assert!(
            hosted_skip_notice_body(HostedSkipReason::ChannelUnapproved, "Claude Code (beta)")
                .contains("Claude Code (beta)에게")
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
        let dm = hosted_skip_notice_props(
            HostedSkipReason::DirectMessageNotApprovable,
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            Uuid::from_u128(4),
        );
        assert!(
            dm.get("notice_action").is_none(),
            "no door to a screen that refuses DMs"
        );
    }

    #[test]
    fn each_reason_throttles_on_its_own_key() {
        let a = Uuid::from_u128(1);
        let keys: Vec<String> = [
            HostedSkipReason::DeliveryNotEnabled,
            HostedSkipReason::ConnectionUnavailable,
            HostedSkipReason::ChannelUnapproved,
            HostedSkipReason::DirectMessageNotApprovable,
        ]
        .into_iter()
        .map(|reason| hosted_skip_notice_key(a, a, a, a, reason))
        .collect();
        let mut unique = keys.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), 4);
    }
}
