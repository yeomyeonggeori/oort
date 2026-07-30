//! Shared JSON payload DTOs (outbox row payloads).
//!
//! Ports the wire shapes the server writes and the workers read:
//!   * broadcast payload (`outbox.payload` for `kind='broadcast'`)
//!   * agent_job payload (`workers/AgentWorker/.../AgentJobPayload.swift`)
//!
//! B0 fixes the field names/shape (snake_case, matching the Swift `CodingKeys`).
//! The agent_job payload's trusted-merge decoding (context-packet vs direct
//! `tool_grants`) is domain logic that lands with `momo-messaging` in B1; here
//! the extra projection keys are simply carried as optional values.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// `outbox.payload` for `kind='broadcast'` — the Centrifugo publish envelope
/// (`{channel, data, version, idempotency_key, ...}`, `001_init.sql:421`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BroadcastPayload {
    pub channel: String,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub idempotency_key: Option<String>,
}

/// `outbox.payload` for `kind='agent_job'` (L4 §3.5). Core dispatch fields plus
/// optional gate seeds. `partition_key = agent_member_id` (set on the outbox
/// row, not here) enforces per-agent serialization at claim time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentJobPayload {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub run_id: Option<Uuid>,
    pub agent_member_id: Uuid,
    pub channel_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub workspace_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub author_member_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trigger_message_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub trigger_message_seq: Option<i64>,
    #[serde(default)]
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub max_output_tokens: Option<i64>,
    // Gate seeds (§3.3/§3.4) — authoritative values live in `agent_run`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub step_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub consecutive_auto: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_packet_id: Option<Uuid>,
    /// Free-form gate/context inputs (recent_messages, tool_grants, memory_refs,
    /// source_attribution, ...). Trusted-merge validation is B1 (momo-messaging).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_job_payload_roundtrips_snake_case() {
        let json = serde_json::json!({
            "agent_member_id": "00000000-0000-0000-0000-000000000001",
            "channel_id": "00000000-0000-0000-0000-000000000002",
            "model": "gpt-x",
            "prompt": "hello",
            "trigger_message_seq": 42,
            "tool_grants": [{"tool_name": "search"}]
        });
        let parsed: AgentJobPayload = serde_json::from_value(json).expect("decode");
        assert_eq!(parsed.model, "gpt-x");
        assert_eq!(parsed.trigger_message_seq, Some(42));
        // Unknown-but-carried projection key preserved via `extra`.
        assert!(parsed.extra.contains_key("tool_grants"));
    }
}
