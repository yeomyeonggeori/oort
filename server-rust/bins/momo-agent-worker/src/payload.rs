//! The `agent_job` payload the server enqueues, as this worker reads it.
//!
//! Producer of truth: Swift `MessageRoutes.mentionJobPayload` (:2276-2346) —
//! the object written into `outbox.payload` for `method='publish'`. Consumer of
//! truth: Swift `AgentWorker/AgentJobPayload.swift`. This struct is the Rust
//! port of the consumer, narrowed to the fields a B5.1 turn actually uses.
//!
//! ## Why unknown fields are ignored rather than rejected
//!
//! Serde's default (`deny_unknown_fields` **off**) is deliberate here. The
//! payload is additive by contract — `context_packet`, `tool_grants`,
//! `memory_refs`, `step_count`, `depth`, `consecutive_auto`, `delivery` all ride
//! along for consumers this batch does not implement — and a strict decode would
//! turn every future server-side addition into a fleet of permanently poisoned
//! jobs. Swift makes the same call (every field is `decodeIfPresent`).
//!
//! What that costs: a payload missing `agent_member_id` or `channel_id` cannot
//! be run at all, so those two stay **required** and a decode failure is
//! terminal (the claim marks the row `failed` rather than retrying poison).

use serde::Deserialize;
use uuid::Uuid;

/// The decoded shape of an `agent_job` outbox row's `payload` (L4 §3.5).
#[derive(Debug, Clone, Deserialize)]
pub struct AgentJobPayload {
    /// `agent_run.id`. Absent on legacy/fixture jobs, which then have no run to
    /// transition and no ledger row to write.
    #[serde(default)]
    pub run_id: Option<Uuid>,
    /// The agent (`member.id`) — also the outbox `partition_key`.
    pub agent_member_id: Uuid,
    pub channel_id: Uuid,
    #[serde(default)]
    pub author_member_id: Option<Uuid>,
    #[serde(default)]
    pub trigger_message_id: Option<Uuid>,
    #[serde(default)]
    pub trigger_message_seq: Option<i64>,
    /// The resolved model (ADR-0134 D4: always on the payload). Empty means
    /// "fall back to `AGENT_MODEL`", matching Swift's `?? ""` decode.
    #[serde(default)]
    pub model: String,
    /// ADR-0134 D2 reasoning effort, recorded on `usage_ledger.effort`.
    #[serde(default)]
    pub effort: Option<String>,
    /// The trigger text. Used only when `recent_messages` is absent (the
    /// amnesiac legacy path).
    #[serde(default)]
    pub prompt: String,
    /// `agent.system_prompt` → the first `system` chat message (MOMO-302).
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Same-channel history window, ASC by seq (MOMO-302).
    #[serde(default)]
    pub recent_messages: Vec<RecentMessage>,
    /// Reserve/limit basis (§8.5). `None` → the config default.
    #[serde(default)]
    pub max_output_tokens: Option<i32>,
    /// Echoed onto the reply's `props` so a client can attribute the answer.
    #[serde(default)]
    pub source_attribution: Option<serde_json::Value>,
}

impl AgentJobPayload {
    /// The model this turn runs on: the payload's resolved value, or the
    /// process default when the server sent none (Swift `Config.agentModel`).
    pub fn model_or<'a>(&'a self, fallback: &'a str) -> &'a str {
        let trimmed = self.model.trim();
        if trimmed.is_empty() {
            fallback
        } else {
            trimmed
        }
    }
}

/// One entry of the projected history window. Every field is optional so a
/// partial projection never fails the whole job decode (Swift parity).
#[derive(Debug, Clone, Deserialize)]
pub struct RecentMessage {
    #[serde(default)]
    pub message_id: Option<Uuid>,
    #[serde(default)]
    pub seq: Option<i64>,
    #[serde(default)]
    pub author_member_id: Option<Uuid>,
    #[serde(default)]
    pub author_display: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The exact object `MessageRoutes.mentionJobPayload` writes must decode,
    /// including the six keys B5.1 does not consume. If this goes red the worker
    /// is rejecting the server's own jobs.
    #[test]
    fn the_servers_mention_payload_decodes_including_the_keys_we_ignore() {
        let agent = Uuid::from_u128(1);
        let channel = Uuid::from_u128(2);
        let run = Uuid::from_u128(3);
        let raw = json!({
            "run_id": run,
            "workspace_id": Uuid::from_u128(4),
            "channel_id": channel,
            "agent_member_id": agent,
            "author_member_id": Uuid::from_u128(5),
            "trigger_message_id": Uuid::from_u128(6),
            "trigger_message_seq": 42,
            "model": "claude-sonnet-4",
            "effort": "high",
            "prompt": "@hermes 안녕",
            "system_prompt": "you are hermes",
            "recent_messages": [
                {"message_id": Uuid::from_u128(6), "seq": 42, "author_member_id": Uuid::from_u128(5),
                 "author_kind": "human", "author_display": "성재", "type": "text", "body": "@hermes 안녕"}
            ],
            // keys this batch does not consume — must not fail the decode
            "tools": {"type": "function"},
            "tool_grants": [{"tool_name": "read"}],
            "memory_refs": [],
            "context_packet_id": Uuid::from_u128(7),
            "context_packet": {"tool_grants": []},
            "context_packet_projection": {"tool_grants": []},
            "source_attribution": {"kind": "message"},
            "max_output_tokens": 2048,
            "step_count": 0,
            "depth": 0,
            "consecutive_auto": 0,
            "delivery": "worker",
            "created_from": "server.message_send.agent_mention.v0",
            "created_at_ms": 1_700_000_000_000i64
        });
        let payload: AgentJobPayload = serde_json::from_value(raw).expect("decode");
        assert_eq!(payload.run_id, Some(run));
        assert_eq!(payload.agent_member_id, agent);
        assert_eq!(payload.channel_id, channel);
        assert_eq!(payload.model_or("fallback"), "claude-sonnet-4");
        assert_eq!(payload.effort.as_deref(), Some("high"));
        assert_eq!(payload.max_output_tokens, Some(2048));
        assert_eq!(payload.recent_messages.len(), 1);
        assert_eq!(
            payload.recent_messages[0].author_display.as_deref(),
            Some("성재")
        );
    }

    /// The two fields without which there is no turn. A payload missing either
    /// is poison, and the worker must fail it permanently rather than retry.
    #[test]
    fn a_payload_without_an_agent_or_a_channel_is_refused() {
        let only_agent = json!({"agent_member_id": Uuid::from_u128(1)});
        assert!(serde_json::from_value::<AgentJobPayload>(only_agent).is_err());
        let only_channel = json!({"channel_id": Uuid::from_u128(2)});
        assert!(serde_json::from_value::<AgentJobPayload>(only_channel).is_err());
    }

    /// Swift decodes `model`/`prompt` as `?? ""`; an absent model must therefore
    /// resolve to the process default rather than sending an empty model id to
    /// the provider (which every gateway answers with a 400).
    #[test]
    fn an_absent_or_blank_model_falls_back_to_the_process_default() {
        let raw = json!({
            "agent_member_id": Uuid::from_u128(1),
            "channel_id": Uuid::from_u128(2),
            "model": "   "
        });
        let payload: AgentJobPayload = serde_json::from_value(raw).expect("decode");
        assert_eq!(payload.model_or("hermes-agent"), "hermes-agent");
        assert_eq!(payload.prompt, "");
        assert!(payload.recent_messages.is_empty());
    }
}
