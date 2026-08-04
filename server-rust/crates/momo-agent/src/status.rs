//! The agent progress rail — `agent.status` on the `agent:` namespace (goal
//! SRV-B3c).
//!
//! ## What was missing
//!
//! `bins/momo-server/src/routes/realtime.rs:168` authorizes subscriptions to
//! `agent:ws<WS>.<CHANNEL>.<AGENT>` — "observable progress, per channel" — and
//! `infra/centrifugo.json` configures the namespace. Every client folds the
//! frames that arrive there into its 작업 중 badge
//! (`packages/momo-core/src/features/agents/agentRail.ts`,
//! `clients/Core/Sources/MomoCore/RealtimeEvent.swift:106-114`).
//!
//! **Nothing in this workspace ever published one.** Measured before this
//! module existed:
//!
//! ```text
//! grep -rn 'agent\.status' server-rust --include='*.rs'   → 0
//! grep -rn 'agent:ws'      server-rust --include='*.rs'   → 3, all in
//!                                                            realtime.rs
//!                                                            (one doc comment,
//!                                                             two #[cfg(test)])
//! ```
//!
//! So the rail was a subscription with no producer: a client could attach, be
//! authorized, and wait forever. The Swift server publishes these frames
//! (`AgentGatewayRoutes.swift:1694-1724`), which is why the clients have folding
//! rules at all — the Rust port simply never brought the emitter across.
//!
//! ## Why this module ships the TERMINAL frame only
//!
//! The full rail is four phases (`queued` → `thinking` → `streaming` → `done`),
//! and the two middle ones are a different kind of work: `thinking`/`streaming`
//! need a producer on every provider event, which on the Rust worker means a
//! callback out of the SSE loop that does not exist yet. The terminal frame
//! needs only the transaction that already writes the terminal row.
//!
//! The asymmetry is not just implementation cost — it is **safety**. A terminal
//! frame is the one frame that cannot lie:
//!
//! ```text
//! agentRail.ts:287-292
//!   if (isRunOver(payload.run_status, payload.phase)) {
//!     if (!tracks.has(runId)) return tracks;   // ← never seen: exact no-op
//!     …delete…
//!   }
//! ```
//!
//! It only ever *deletes* from the client's run table, and returns the identical
//! map when there is nothing to delete — so publishing it into clients that have
//! seen no opening frame cannot invent a 작업 중 badge, cannot start a clock, and
//! cannot survive a Centrifugo replay as a false claim (the `agent` namespace is
//! `force_recovery: true` with 24h of history). macOS reaches the same place by
//! a different road: `ChatViewModel.trackWorkingClock` nils the clock and
//! `AgentWorkingSignal` skips terminal statuses outright.
//!
//! Emitting the opening/streaming halves is therefore a **separate, larger**
//! goal, and one that must not be inferred from this one: a `queued` frame with
//! no matching terminal frame is exactly the stranded badge the clients' 90s TTL
//! exists to paper over.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::run::RunStatus;

/// `data.type` of a progress-rail status frame.
pub const AGENT_STATUS_EVENT_TYPE: &str = "agent.status";

/// `data.v`. macOS decodes this as a **required** `Int`
/// (`clients/Core/.../RealtimeEnvelope.swift`), so it is never omitted.
pub const AGENT_STATUS_EVENT_VERSION: i64 = 1;

/// `payload.phase` — the client's `AgentPhaseWire`
/// (`packages/momo-core/src/lib/realtimeEvents.ts:186-191`).
///
/// Only the two terminal members are constructed here; the other three
/// (`queued`, `thinking`, `streaming`) belong to the opening/streaming producer
/// this module deliberately does not ship. They are still spelled out because
/// macOS decodes `phase` as a **strict enum** and a value outside this set drops
/// the whole frame rather than one field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPhase {
    Done,
    Error,
}

impl AgentPhase {
    pub fn as_wire(self) -> &'static str {
        match self {
            AgentPhase::Done => "done",
            AgentPhase::Error => "error",
        }
    }
}

/// How a terminal [`RunStatus`] reads on the rail.
///
/// `succeeded` is the only outcome that finished the thing it set out to do, so
/// it is the only `done`; everything else is `error`. That is Swift's mapping at
/// its one data point (`agentStatusProjection`: `cancelled → ("error",
/// "cancelled")`) extended along the axis it was already drawing.
///
/// **`phase` and `run_status` are not redundant.** The clients treat *either* as
/// proof the turn is over (`isRunOver`: `phase === "done" || phase === "error"`
/// first, then the four run statuses), and they render the *reason* from
/// `run_status` — so a stopped run and a failed one stay tellable apart while
/// both clear the badge. Collapsing them into one field is exactly the
/// projection bug this goal exists to answer: Swift folds every non-streaming,
/// non-cancelled status into `("thinking", "running")`, which is why its
/// successful runs never announce that they ended.
pub fn terminal_phase(status: RunStatus) -> Option<AgentPhase> {
    match status {
        RunStatus::Succeeded => Some(AgentPhase::Done),
        RunStatus::Failed | RunStatus::Cancelled | RunStatus::TimedOut => Some(AgentPhase::Error),
        // Not terminal: the run row is genuinely still open. `awaiting_approval`
        // in particular must NOT be published as terminal — the clients render
        // it as 승인 대기, and ending the turn here would hide a decision that is
        // waiting for a person.
        _ => None,
    }
}

/// The Centrifugo channel a run's progress belongs to.
///
/// Uppercased because that is what every client builds and what the namespace
/// regex in `infra/centrifugo.json` accepts
/// (`^ws[0-9A-Fa-f-]{36}\.[0-9A-Fa-f-]{36}\.[0-9A-Fa-f-]{36}$`); the client
/// helper is `centrifugoAgentChannelName`
/// (`packages/momo-core/src/lib/realtimeEvents.ts:232-238`). A lowercase name
/// would pass the regex and then simply never match a subscriber.
pub fn agent_status_channel(workspace_id: Uuid, channel_id: Uuid, agent_member_id: Uuid) -> String {
    format!(
        "agent:ws{}.{}.{}",
        upper(workspace_id),
        upper(channel_id),
        upper(agent_member_id)
    )
}

/// The outbox payload for one terminal `agent.status` frame, in the
/// `{channel, data, idempotency_key}` shape `momo-relay` forwards verbatim
/// (`bins/momo-relay/src/centrifugo.rs:9-12`).
///
/// Returns `None` for a non-terminal status rather than publishing a half-true
/// frame — the callers are the sites that just wrote a terminal row, so a `None`
/// here means the row and the frame disagree and the frame is the one that gets
/// dropped.
///
/// No `version` key: that field is `message.seq` and a status frame has no place
/// in a channel's sequence. Omitting it is what keeps the rail out of the
/// ordering the timeline depends on.
///
/// The `idempotency_key` is keyed on the **run**, not on an event id, because
/// there is exactly one terminal frame per run by construction — every producer
/// below it is guarded by a status transition that only fires once. Centrifugo's
/// 5-minute cache then makes a retried outbox delivery a no-op instead of a
/// second delete.
pub fn terminal_agent_status_payload(
    workspace_id: Uuid,
    channel_id: Uuid,
    agent_member_id: Uuid,
    run_id: Uuid,
    status: RunStatus,
    hlc_ts: i64,
) -> Option<Value> {
    let phase = terminal_phase(status)?;
    let channel = agent_status_channel(workspace_id, channel_id, agent_member_id);
    Some(json!({
        "channel": channel,
        "data": {
            "type": AGENT_STATUS_EVENT_TYPE,
            "v": AGENT_STATUS_EVENT_VERSION,
            "ts": hlc_ts,
            "payload": {
                // Uppercased like Swift's `uuidString`, which is what the
                // clients' fixtures carry. `keyOf` case-folds on the web side,
                // but macOS compares the decoded UUID, so either casing works —
                // matching Swift keeps one wire shape instead of two.
                "run_id": upper(run_id),
                "agent_member_id": upper(agent_member_id),
                "channel_id": upper(channel_id),
                "phase": phase.as_wire(),
                "run_status": status.as_db_label(),
            },
        },
        "idempotency_key": format!("{channel}:agent_status:{}:terminal", upper(run_id)),
    }))
}

fn upper(id: Uuid) -> String {
    id.to_string().to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The channel name the clients subscribe to, built the way they build it.
    #[test]
    fn the_channel_matches_the_clients_helper_and_the_namespace_regex() {
        let workspace = Uuid::parse_str("019f994e-6b8d-7f13-a324-ec4b954f2635").expect("uuid");
        let channel = Uuid::parse_str("019f994e-6b8d-7f13-a324-ec4b954f2636").expect("uuid");
        let agent = Uuid::parse_str("019f994e-6b8d-7f13-a324-ec4b954f2637").expect("uuid");
        let name = agent_status_channel(workspace, channel, agent);
        assert_eq!(
            name,
            "agent:ws019F994E-6B8D-7F13-A324-EC4B954F2635\
             .019F994E-6B8D-7F13-A324-EC4B954F2636\
             .019F994E-6B8D-7F13-A324-EC4B954F2637"
        );
        // The namespace regex wants exactly three dot-separated 36-char ids
        // after `ws`; two would be `agentwork`'s shape and would never be
        // delivered here.
        let suffix = name.strip_prefix("agent:ws").expect("namespace prefix");
        assert_eq!(suffix.split('.').count(), 3, "{name}");
        assert!(
            suffix.split('.').all(|part| part.len() == 36),
            "every segment is a full uuid: {name}"
        );
        assert!(
            !suffix.contains(char::is_lowercase),
            "a lowercase id passes the regex and then matches no subscriber: {name}"
        );
    }

    /// The wire shape, field for field, against the clients' declared types.
    #[test]
    fn the_frame_carries_every_field_the_strictest_client_requires() {
        let payload = terminal_agent_status_payload(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            Uuid::from_u128(4),
            RunStatus::Succeeded,
            1_784_983_000_000,
        )
        .expect("succeeded is terminal");

        // macOS decodes `v` and `ts` as required Ints and every payload id as a
        // required UUID; a missing one drops the WHOLE frame, not one field.
        let data = &payload["data"];
        assert_eq!(data["type"], json!("agent.status"));
        assert_eq!(data["v"], json!(1));
        assert_eq!(data["ts"], json!(1_784_983_000_000i64));
        for key in [
            "run_id",
            "agent_member_id",
            "channel_id",
            "phase",
            "run_status",
        ] {
            assert!(
                data["payload"]
                    .get(key)
                    .is_some_and(|value| !value.is_null()),
                "{key} is required by MomoCore's RealtimeEvent decoder: {payload}"
            );
        }
        assert_eq!(data["payload"]["phase"], json!("done"));
        assert_eq!(data["payload"]["run_status"], json!("succeeded"));

        // The relay forwards `version` when present, and `version` means
        // `message.seq`. A status frame has no seq.
        assert!(
            payload.get("version").is_none(),
            "a status frame must not claim a place in the channel's sequence: {payload}"
        );
        assert!(payload["idempotency_key"]
            .as_str()
            .expect("key")
            .ends_with(":terminal"));
    }

    /// Every terminal status produces a frame the clients read as "over", and
    /// the two axes stay independent so the *reason* survives.
    #[test]
    fn each_terminal_status_is_over_on_the_wire_and_keeps_its_reason() {
        for (status, phase, label) in [
            (RunStatus::Succeeded, "done", "succeeded"),
            (RunStatus::Failed, "error", "failed"),
            (RunStatus::Cancelled, "error", "cancelled"),
            (RunStatus::TimedOut, "error", "timed_out"),
        ] {
            let payload = terminal_agent_status_payload(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                Uuid::from_u128(3),
                Uuid::from_u128(4),
                status,
                7,
            )
            .unwrap_or_else(|| panic!("{label} is terminal"));
            let body = &payload["data"]["payload"];
            assert_eq!(body["phase"], json!(phase), "{label}");
            assert_eq!(body["run_status"], json!(label), "{label}");
            // `isRunOver` (agentRail.ts:164-171) reads either axis; this asserts
            // BOTH say over, so a client that checks only one still clears.
            assert!(
                body["phase"] == json!("done") || body["phase"] == json!("error"),
                "{label}"
            );
            assert!(
                ["succeeded", "failed", "cancelled", "timed_out"]
                    .contains(&body["run_status"].as_str().expect("label")),
                "{label}"
            );
        }
    }

    /// The frame is refused for every status that is not terminal — most
    /// importantly `awaiting_approval`, which the clients render as 승인 대기.
    /// Publishing that as `done` would erase a decision waiting for a person.
    #[test]
    fn a_live_run_never_gets_a_terminal_frame() {
        for status in [
            RunStatus::Queued,
            RunStatus::Running,
            RunStatus::AwaitingApproval,
        ] {
            assert_eq!(terminal_phase(status), None, "{status:?}");
            assert!(
                terminal_agent_status_payload(
                    Uuid::from_u128(1),
                    Uuid::from_u128(2),
                    Uuid::from_u128(3),
                    Uuid::from_u128(4),
                    status,
                    7,
                )
                .is_none(),
                "{status:?} must not be published as the end of a turn"
            );
        }
    }

    /// One run, one terminal frame — the key does not vary with time or with
    /// which producer emitted it, so a retried delivery is a no-op rather than a
    /// second delete.
    #[test]
    fn the_idempotency_key_is_per_run_not_per_delivery() {
        let key = |ts| {
            terminal_agent_status_payload(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                Uuid::from_u128(3),
                Uuid::from_u128(4),
                RunStatus::Succeeded,
                ts,
            )
            .expect("terminal")["idempotency_key"]
                .as_str()
                .expect("key")
                .to_string()
        };
        assert_eq!(key(1), key(2));
        let other_run = terminal_agent_status_payload(
            Uuid::from_u128(1),
            Uuid::from_u128(2),
            Uuid::from_u128(3),
            Uuid::from_u128(5),
            RunStatus::Succeeded,
            1,
        )
        .expect("terminal")["idempotency_key"]
            .as_str()
            .expect("key")
            .to_string();
        assert_ne!(key(1), other_run, "two runs are two frames");
    }
}
