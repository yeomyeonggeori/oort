//! Subscription agents are the owner's alone (ADR-0193 D4·D5·D6, #2815 OB2-9).
//!
//! An agent that joined through the subscription path — "이 맥의 Claude Code ·
//! Codex", the owner's own CLI logged into the owner's own consumer plan — is
//! recorded as `agent.invocation_scope = 'owner_only'` (migration 089). Its brain
//! is one person's subscription, and consumer terms do not let that person lend
//! it to a team, so **only `agent.owner_human_id` may invoke it**.
//!
//! ## What this module owns
//!
//! * the three agent-attributed sentences a server may post on the agent's
//!   behalf ([`SubscriptionNoticeKind`]) and their bodies;
//! * the pure gate that decides, before any hosted-delivery question is asked,
//!   whether an addressed `owner_only` agent may be called at all
//!   ([`owner_only_gate`]);
//! * the throttle's key and lookup (same thread, same person, same sentence, at
//!   most once per [`SUBSCRIPTION_NOTICE_THROTTLE_SECONDS`]);
//! * the one write that turns a fresh hosted identity into an `owner_only` one
//!   ([`mark_agent_owner_only_in_tx`]).
//!
//! ## What it deliberately does not own
//!
//! The message write. A notice is a message, so it goes through
//! `momo_messaging`'s single write path (`channel_seq` bump + `message` INSERT +
//! broadcast outbox INSERT, one transaction) exactly like ADR-0181 D5's static
//! `provider_required` line does — authored by the agent member, no run, no
//! model call, no subscription use. The route layer composes the two, the same
//! split `mention.rs` documents for the paused line.

use momo_db::DbError;
use serde_json::{json, Value};
use sqlx::PgConnection;
use uuid::Uuid;

/// `agent.invocation_scope` for a subscription agent (migration 089).
pub const INVOCATION_SCOPE_OWNER_ONLY: &str = "owner_only";
/// `agent.invocation_scope` for every other agent (the column default).
pub const INVOCATION_SCOPE_WORKSPACE: &str = "workspace";

/// Same thread, same person, same sentence: at most once per ten minutes
/// (ADR-0193 D4, planner 판정 2026-09-26). Measured on the database clock
/// against the previous notice's `created_at`, never as a time bucket — a
/// bucket would let 9:59 and 10:01 both through.
pub const SUBSCRIPTION_NOTICE_THROTTLE_SECONDS: i64 = 600;

/// How recently the active connection's credential must have reached the Agent
/// Port for the agent to count as online (ADR-0193 D5).
///
/// **This is a heuristic and the PR says so.** The server observes exactly one
/// liveness fact for a hosted runtime: `token.last_used_at`, touched on every
/// admitted Agent Port request. Whether an idle, open Claude Code or Codex
/// session reaches the port on its own is not something this server can see.
/// Ten minutes matches the notice throttle, so an owner who keeps calling a
/// silent agent hears "offline" at most once per window. A false "offline" is
/// still a true sentence about the call itself: when a live connection exists
/// the job is queued and claimed on the next visit, which is why that variant
/// says 「이어서 답할게요」.
pub const SUBSCRIPTION_AGENT_ONLINE_WINDOW_SECONDS: i64 = 600;

/// `message.props.source` of every notice this module describes.
pub const SUBSCRIPTION_NOTICE_SOURCE: &str = "server.subscription_agent.notice.v1";

/// `audit_log.action` for a posted notice.
pub const SUBSCRIPTION_NOTICE_POSTED_ACTION: &str = "agent.subscription.notice_posted";
/// `audit_log.action` for a notice the throttle held back.
pub const SUBSCRIPTION_NOTICE_THROTTLED_ACTION: &str = "agent.subscription.notice_throttled";
pub const SUBSCRIPTION_NOTICE_AUDIT_SCHEMA: &str = "momo.agent.subscription_notice.v1";

/// The mention skip reasons this ADR adds (`agent.mention.skipped`).
pub const SKIP_OWNER_ONLY_NON_OWNER: &str = "owner_only_non_owner";
pub const SKIP_SUBSCRIPTION_AGENTS_DISABLED: &str = "subscription_agents_disabled";

/// Which official CLI the owner runs (`agent.subscription_harness`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionHarness {
    ClaudeCode,
    Codex,
}

impl SubscriptionHarness {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "claude_code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }

    /// The product name the D5 sentence says.
    pub fn product_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
        }
    }
}

/// An addressed agent's `owner_only` facts, read with the candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerOnlyScope {
    pub owner_member_id: Uuid,
    pub owner_display_name: String,
    pub harness: SubscriptionHarness,
    /// The active connection's credential reached the Agent Port within
    /// [`SUBSCRIPTION_AGENT_ONLINE_WINDOW_SECONDS`].
    pub recently_seen: bool,
    /// A connection exists that a relaunch of the CLI can still finish
    /// (`pairing_pending` / `detected`). Expired, revoked or disconnected
    /// connections need a new pairing, so no "다시 열면" sentence is true for
    /// them and none is posted.
    pub reconnectable: bool,
}

/// The three sentences (ADR-0193 D4·D5·D6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionNoticeKind {
    /// D4 — someone other than the owner called.
    NonOwner,
    /// D5 — the owner called while the CLI is away; the job **is queued** on a
    /// live connection and the next visit claims it.
    OfflineQueued,
    /// D5 — the owner called while the connection is not live yet (pairing not
    /// finished); nothing is queued, so the sentence promises only the future.
    OfflineNotQueued,
    /// D6 — the operator turned the subscription path off.
    Disabled,
}

impl SubscriptionNoticeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NonOwner => "non_owner",
            // Both offline variants share one throttle: the person is told once
            // per window that the CLI is away, whichever sentence was true.
            Self::OfflineQueued | Self::OfflineNotQueued => "offline",
            Self::Disabled => "disabled",
        }
    }
}

/// The sentence for `kind`. Only the owner's display name and the product name
/// are ever interpolated — never a device name, a location or a last-seen time
/// (ADR-0193 D5: others see "offline" and nothing more).
pub fn subscription_notice_body(kind: SubscriptionNoticeKind, scope: &OwnerOnlyScope) -> String {
    match kind {
        SubscriptionNoticeKind::NonOwner => format!(
            "{}의 개인 에이전트예요. 팀이 함께 부르는 에이전트는 설정 › AI 연결에서 붙일 수 있어요.",
            scope.owner_display_name
        ),
        SubscriptionNoticeKind::OfflineQueued => format!(
            "지금은 오프라인이에요. 맥에서 {}를 다시 열면 이어서 답할게요.",
            scope.harness.product_name()
        ),
        SubscriptionNoticeKind::OfflineNotQueued => format!(
            "지금은 오프라인이에요. 맥에서 {}를 다시 열면 답할 수 있어요.",
            scope.harness.product_name()
        ),
        SubscriptionNoticeKind::Disabled => {
            "지금은 이 서버에서 구독 에이전트를 쓸 수 없어요. 설정 › AI 연결에서 API 키로 연결할 수 있어요."
                .to_string()
        }
    }
}

/// Decide whether an addressed `owner_only` agent may be called at all.
///
/// `None` = not refused here (not `owner_only`, or the owner with the path on);
/// the ordinary hosted checks run next. `Some(kind)` = refused, answer `kind`.
///
/// The order is the ADR's: a non-owner is told whose agent this is even when
/// the operator has turned the path off — they could not have called it either
/// way, and the D4 sentence is the one that points them somewhere useful. The
/// owner, with the switch off, is told the D6 sentence.
pub fn owner_only_gate(
    scope: Option<&OwnerOnlyScope>,
    author_member_id: Uuid,
    subscription_agents_enabled: bool,
) -> Option<SubscriptionNoticeKind> {
    let scope = scope?;
    if author_member_id != scope.owner_member_id {
        return Some(SubscriptionNoticeKind::NonOwner);
    }
    if !subscription_agents_enabled {
        return Some(SubscriptionNoticeKind::Disabled);
    }
    None
}

/// Where a notice about `trigger` belongs: the thread it was said in, or a new
/// thread under it when it was said in the channel's main timeline.
pub fn notice_root(trigger_message_id: Uuid, trigger_root_id: Option<Uuid>) -> Uuid {
    trigger_root_id.unwrap_or(trigger_message_id)
}

/// The throttle's "same thread". A reply's thread is its root; the channel's
/// main timeline is one conversation, so top-level calls share the channel as
/// their key — otherwise every top-level re-mention would open a fresh thread
/// and the ten-minute rule would never apply to the most common case.
pub fn notice_thread_key(channel_id: Uuid, trigger_root_id: Option<Uuid>) -> Uuid {
    trigger_root_id.unwrap_or(channel_id)
}

/// The idempotency key the throttle serializes on.
pub fn subscription_notice_key(
    agent_member_id: Uuid,
    channel_id: Uuid,
    thread_key: Uuid,
    recipient_member_id: Uuid,
    kind: SubscriptionNoticeKind,
) -> String {
    format!(
        "subscription_notice:{agent_member_id}:{channel_id}:{thread_key}:{recipient_member_id}:{}",
        kind.as_str()
    )
}

/// `message.props` of a notice. The throttle reads these keys back.
pub fn subscription_notice_props(
    kind: SubscriptionNoticeKind,
    recipient_member_id: Uuid,
    thread_key: Uuid,
    trigger_message_id: Uuid,
) -> Value {
    json!({
        "source": SUBSCRIPTION_NOTICE_SOURCE,
        "subscription_notice": kind.as_str(),
        "notice_for_member_id": recipient_member_id,
        "notice_thread_key": thread_key,
        "trigger_message_id": trigger_message_id,
    })
}

/// Take the throttle's lock and report whether a notice with the same key was
/// already posted inside the window.
///
/// The advisory lock serializes two concurrent calls on the same key inside
/// their transactions, so the lookup and the write that follows it are one
/// decision: the second caller waits, then sees the first caller's row.
pub async fn lock_and_find_recent_notice_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    channel_id: Uuid,
    thread_key: Uuid,
    recipient_member_id: Uuid,
    kind: SubscriptionNoticeKind,
) -> Result<bool, DbError> {
    let key = subscription_notice_key(
        agent_member_id,
        channel_id,
        thread_key,
        recipient_member_id,
        kind,
    );
    lock_and_find_recent_server_notice_in_tx(
        conn,
        RecentNotice {
            key: &key,
            workspace_id,
            channel_id,
            author_member_id: agent_member_id,
            source: SUBSCRIPTION_NOTICE_SOURCE,
            kind_prop: "subscription_notice",
            kind: kind.as_str(),
            recipient_member_id,
            thread_key,
            window_seconds: SUBSCRIPTION_NOTICE_THROTTLE_SECONDS,
        },
    )
    .await
}

/// One throttle question: was a server-composed notice with this
/// `(source, props[kind_prop] = kind, recipient, thread)` posted by this author
/// inside the window? Shared by ADR-0193's notices and #2871's hosted skip
/// lines so both answer "same thread, same person, same sentence" identically.
#[derive(Debug, Clone, Copy)]
pub struct RecentNotice<'a> {
    /// The advisory-lock key. Must name every field the lookup filters on.
    pub key: &'a str,
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub author_member_id: Uuid,
    pub source: &'a str,
    pub kind_prop: &'a str,
    pub kind: &'a str,
    pub recipient_member_id: Uuid,
    pub thread_key: Uuid,
    pub window_seconds: i64,
}

/// Take the advisory lock on `notice.key`, then look the notice up.
///
/// The lock serializes two concurrent calls on the same key inside their
/// transactions, so the lookup and the write that follows it are one decision:
/// the second caller waits, then sees the first caller's row.
pub async fn lock_and_find_recent_server_notice_in_tx(
    conn: &mut PgConnection,
    notice: RecentNotice<'_>,
) -> Result<bool, DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1::text))")
        .bind(notice.key)
        .execute(&mut *conn)
        .await?;
    let found: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
            SELECT 1 FROM message \
             WHERE workspace_id = $1 \
               AND channel_id = $2 \
               AND author_member_id = $3 \
               AND props->>'source' = $4 \
               AND props->>($5::text) = $6 \
               AND props->>'notice_for_member_id' = $7 \
               AND props->>'notice_thread_key' = $8 \
               AND created_at > now() - make_interval(secs => $9) \
         )",
    )
    .bind(notice.workspace_id)
    .bind(notice.channel_id)
    .bind(notice.author_member_id)
    .bind(notice.source)
    .bind(notice.kind_prop)
    .bind(notice.kind)
    .bind(notice.recipient_member_id.to_string())
    .bind(notice.thread_key.to_string())
    .bind(notice.window_seconds as f64)
    .fetch_one(&mut *conn)
    .await?;
    Ok(found)
}

/// Record a freshly created hosted identity as the owner's subscription agent.
///
/// One-way by construction: migration 089's trigger refuses every later UPDATE
/// that would reopen the scope, change the owner or change the harness, so this
/// is the only transition that exists (ADR-0193 D4 「소유자는 바꿀 수 없다」).
/// Returns `false` when no agent row matched (the caller treats that as a bug).
pub async fn mark_agent_owner_only_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
    harness: SubscriptionHarness,
) -> Result<bool, DbError> {
    let updated = sqlx::query(
        "UPDATE agent SET invocation_scope = 'owner_only', subscription_harness = $3, \
                updated_at = now() \
          WHERE workspace_id = $1 AND member_id = $2 AND owner_human_id IS NOT NULL",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .bind(harness.as_str())
    .execute(&mut *conn)
    .await?;
    Ok(updated.rows_affected() == 1)
}

/// Is `agent_member_id` an `owner_only` agent? Used by surfaces that only need
/// the yes/no (the Agent Port tool view under the kill switch).
pub async fn agent_is_owner_only_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_id: Uuid,
) -> Result<bool, DbError> {
    let scope: Option<String> = sqlx::query_scalar(
        "SELECT invocation_scope FROM agent WHERE workspace_id = $1 AND member_id = $2",
    )
    .bind(workspace_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(scope.as_deref() == Some(INVOCATION_SCOPE_OWNER_ONLY))
}

/// `(invocation_scope, subscription_harness)` per agent, for DTO projection.
pub async fn load_invocation_scopes_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    agent_member_ids: &[Uuid],
) -> Result<Vec<(Uuid, String, Option<String>)>, DbError> {
    let rows: Vec<(Uuid, String, Option<String>)> = sqlx::query_as(
        "SELECT member_id, invocation_scope, subscription_harness FROM agent \
          WHERE workspace_id = $1 AND member_id = ANY($2)",
    )
    .bind(workspace_id)
    .bind(agent_member_ids)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(owner: Uuid) -> OwnerOnlyScope {
        OwnerOnlyScope {
            owner_member_id: owner,
            owner_display_name: "성재".into(),
            harness: SubscriptionHarness::ClaudeCode,
            recently_seen: true,
            reconnectable: false,
        }
    }

    #[test]
    fn the_gate_refuses_a_non_owner_before_the_switch_and_the_owner_only_when_off() {
        let owner = Uuid::from_u128(1);
        let other = Uuid::from_u128(2);
        let s = scope(owner);
        assert_eq!(owner_only_gate(None, other, true), None, "workspace agents");
        assert_eq!(owner_only_gate(None, other, false), None);
        assert_eq!(
            owner_only_gate(Some(&s), other, true),
            Some(SubscriptionNoticeKind::NonOwner)
        );
        assert_eq!(
            owner_only_gate(Some(&s), other, false),
            Some(SubscriptionNoticeKind::NonOwner),
            "a non-owner hears whose agent this is, never the operator's switch"
        );
        assert_eq!(owner_only_gate(Some(&s), owner, true), None);
        assert_eq!(
            owner_only_gate(Some(&s), owner, false),
            Some(SubscriptionNoticeKind::Disabled)
        );
    }

    #[test]
    fn the_sentences_are_the_adr_sentences_and_carry_no_device_detail() {
        let s = scope(Uuid::from_u128(1));
        assert_eq!(
            subscription_notice_body(SubscriptionNoticeKind::NonOwner, &s),
            "성재의 개인 에이전트예요. 팀이 함께 부르는 에이전트는 설정 › AI 연결에서 붙일 수 있어요."
        );
        assert_eq!(
            subscription_notice_body(SubscriptionNoticeKind::OfflineNotQueued, &s),
            "지금은 오프라인이에요. 맥에서 Claude Code를 다시 열면 답할 수 있어요."
        );
        assert_eq!(
            subscription_notice_body(SubscriptionNoticeKind::OfflineQueued, &s),
            "지금은 오프라인이에요. 맥에서 Claude Code를 다시 열면 이어서 답할게요."
        );
        let codex = OwnerOnlyScope {
            harness: SubscriptionHarness::Codex,
            ..s.clone()
        };
        assert!(
            subscription_notice_body(SubscriptionNoticeKind::OfflineQueued, &codex)
                .contains("맥에서 Codex를")
        );
        assert_eq!(
            subscription_notice_body(SubscriptionNoticeKind::Disabled, &s),
            "지금은 이 서버에서 구독 에이전트를 쓸 수 없어요. 설정 › AI 연결에서 API 키로 연결할 수 있어요."
        );
    }

    #[test]
    fn a_top_level_call_threads_under_itself_but_throttles_on_the_channel() {
        let channel = Uuid::from_u128(10);
        let trigger = Uuid::from_u128(11);
        let root = Uuid::from_u128(12);
        assert_eq!(notice_root(trigger, None), trigger);
        assert_eq!(notice_root(trigger, Some(root)), root);
        assert_eq!(notice_thread_key(channel, None), channel);
        assert_eq!(notice_thread_key(channel, Some(root)), root);
    }

    #[test]
    fn both_offline_sentences_share_one_throttle_kind() {
        assert_eq!(
            SubscriptionNoticeKind::OfflineQueued.as_str(),
            SubscriptionNoticeKind::OfflineNotQueued.as_str()
        );
        assert_ne!(
            SubscriptionNoticeKind::NonOwner.as_str(),
            SubscriptionNoticeKind::Disabled.as_str()
        );
    }

    #[test]
    fn harness_round_trips_and_refuses_anything_else() {
        for harness in [SubscriptionHarness::ClaudeCode, SubscriptionHarness::Codex] {
            assert_eq!(SubscriptionHarness::parse(harness.as_str()), Some(harness));
        }
        assert_eq!(SubscriptionHarness::parse("grok"), None);
        assert_eq!(SubscriptionHarness::parse("Claude_Code"), None);
    }
}
