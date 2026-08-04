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

/// `data.type` of a streamed answer slice.
pub const AGENT_PARTIAL_EVENT_TYPE: &str = "agent.partial";

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
    /// The run row exists and nothing has claimed it yet. **The only frame that
    /// proves when a turn began** — `isRunOpening` (`agentRail.ts:227-229`) reads
    /// it, and a rail that never sees one renders the badge with no clock.
    Queued,
    /// Claimed and working, with nothing to show yet.
    Thinking,
    /// Text is arriving.
    Streaming,
    Done,
    Error,
}

impl AgentPhase {
    pub fn as_wire(self) -> &'static str {
        match self {
            AgentPhase::Queued => "queued",
            AgentPhase::Thinking => "thinking",
            AgentPhase::Streaming => "streaming",
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
    Some(agent_status_payload(
        AgentRunAddress {
            workspace_id,
            channel_id,
            agent_member_id,
            run_id,
        },
        phase,
        status.as_db_label(),
        hlc_ts,
        "terminal",
    ))
}

/// The four ids every rail frame is addressed by.
///
/// A struct rather than four positional `Uuid`s because that is exactly the
/// shape a transposition bug hides in: `(workspace, channel, agent, run)` would
/// compile with any two of them swapped and publish a turn onto a channel nobody
/// is watching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentRunAddress {
    pub workspace_id: Uuid,
    pub channel_id: Uuid,
    pub agent_member_id: Uuid,
    pub run_id: Uuid,
}

/// The opening frame — `(queued, queued)`, published when the run row is created
/// (goal SRV-B3d).
///
/// This is the frame that carries **when the turn began**. Without it a client
/// that attaches mid-turn honestly has no start time and renders the badge with
/// no clock (`agentRail.ts:145-149`: "when we first noticed" is not "when the
/// agent started", so it is left unknown rather than guessed).
///
/// It is safe to publish before any consumer exists because the run genuinely IS
/// queued at that moment: if nothing ever claims the job, the badge is telling
/// the truth until the client's own 90s idle cutoff retires it. That fallback is
/// what makes an opening frame safe to send without a guarantee that a terminal
/// one follows — and it is why the terminal producers landed first (goal
/// SRV-B3c) rather than after this.
pub fn opening_agent_status_payload(address: AgentRunAddress, hlc_ts: i64) -> Value {
    agent_status_payload(
        address,
        AgentPhase::Queued,
        RunStatus::Queued.as_db_label(),
        hlc_ts,
        "queued",
    )
}

/// A mid-turn frame — `(thinking | streaming, running)`.
///
/// `key` distinguishes one progress frame from the next. Unlike the terminal and
/// opening frames there is no "exactly one per run" property to lean on, so the
/// caller supplies whatever makes ITS frame unique (a gateway event id, or the
/// phase name when the producer fires once per run). Getting this wrong is not a
/// crash but a silence: Centrifugo's 5-minute idempotency cache would swallow
/// the second frame under the same key.
pub fn progress_agent_status_payload(
    address: AgentRunAddress,
    phase: AgentPhase,
    hlc_ts: i64,
    key: &str,
) -> Value {
    agent_status_payload(address, phase, "running", hlc_ts, key)
}

/// One `agent.partial` — a slice of the answer as it is produced.
///
/// `text_delta` only, never `text`: the cumulative field is a worker convenience
/// the clients prefer for the headline (`applyPartial` reads `text` first), and
/// a relay that does not hold the accumulated answer must not pretend to. The
/// client's `headlineFrom(text_delta)` fallback is the documented path for
/// exactly this producer.
///
/// A partial **creates** a client-side track entry when none exists
/// (`agentRail.ts:325-338`), unlike a terminal frame — which is correct, because
/// a delta is proof the agent is working right now, but it means a partial must
/// never be published for a run that is not actually streaming.
pub fn agent_partial_payload(
    address: AgentRunAddress,
    text_delta: &str,
    hlc_ts: i64,
    key: &str,
) -> Value {
    let channel = agent_status_channel(
        address.workspace_id,
        address.channel_id,
        address.agent_member_id,
    );
    json!({
        "channel": channel,
        "data": {
            "type": AGENT_PARTIAL_EVENT_TYPE,
            "v": AGENT_STATUS_EVENT_VERSION,
            "ts": hlc_ts,
            "payload": {
                "run_id": upper(address.run_id),
                "agent_member_id": upper(address.agent_member_id),
                "channel_id": upper(address.channel_id),
                "text_delta": text_delta,
            },
        },
        "idempotency_key": format!(
            "{channel}:agent_partial:{}:{key}",
            upper(address.run_id)
        ),
    })
}

/// The one place a rail frame is shaped.
fn agent_status_payload(
    address: AgentRunAddress,
    phase: AgentPhase,
    run_status: &str,
    hlc_ts: i64,
    key: &str,
) -> Value {
    let channel = agent_status_channel(
        address.workspace_id,
        address.channel_id,
        address.agent_member_id,
    );
    json!({
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
                "run_id": upper(address.run_id),
                "agent_member_id": upper(address.agent_member_id),
                "channel_id": upper(address.channel_id),
                "phase": phase.as_wire(),
                "run_status": run_status,
            },
        },
        "idempotency_key": format!(
            "{channel}:agent_status:{}:{key}",
            upper(address.run_id)
        ),
    })
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
    /// The opening frame is the ONLY one that proves when a turn began, so it
    /// must satisfy `isRunOpening` — which reads *either* axis.
    #[test]
    fn the_opening_frame_is_what_starts_the_clients_clock() {
        let frame = opening_agent_status_payload(address(), 1_784_983_000_000);
        let body = &frame["data"]["payload"];
        assert_eq!(body["phase"], json!("queued"));
        assert_eq!(body["run_status"], json!("queued"));
        // agentRail.ts:227-229 — `phase === "queued" || run_status === "queued"`.
        assert!(
            body["phase"] == json!("queued") || body["run_status"] == json!("queued"),
            "without this the badge renders with no elapsed clock: {frame}"
        );
        // …and it is NOT read as the end of the turn.
        assert_ne!(body["phase"], json!("done"));
        assert_ne!(body["phase"], json!("error"));
    }

    /// A mid-turn frame says the run is running and nothing else. In particular
    /// it must never spell a terminal phase, or the badge clears mid-answer.
    #[test]
    fn a_progress_frame_is_never_read_as_the_end_of_a_turn() {
        for (phase, wire) in [
            (AgentPhase::Thinking, "thinking"),
            (AgentPhase::Streaming, "streaming"),
        ] {
            let frame = progress_agent_status_payload(address(), phase, 7, "k");
            let body = &frame["data"]["payload"];
            assert_eq!(body["phase"], json!(wire));
            assert_eq!(body["run_status"], json!("running"));
            // `isRunOver` would clear the badge on either axis.
            assert!(
                body["phase"] != json!("done") && body["phase"] != json!("error"),
                "{wire}"
            );
            assert!(
                !["succeeded", "failed", "cancelled", "timed_out"]
                    .contains(&body["run_status"].as_str().expect("label")),
                "{wire}"
            );
        }
    }

    /// Progress frames are distinguished by the caller's key — two frames under
    /// one key is a frame Centrifugo's cache silently eats.
    #[test]
    fn progress_frames_are_told_apart_by_their_key() {
        let a = progress_agent_status_payload(address(), AgentPhase::Thinking, 7, "one");
        let b = progress_agent_status_payload(address(), AgentPhase::Streaming, 8, "two");
        assert_ne!(a["idempotency_key"], b["idempotency_key"]);
        // …and the opening frame cannot collide with a progress frame either.
        let opening = opening_agent_status_payload(address(), 6);
        assert_ne!(opening["idempotency_key"], a["idempotency_key"]);
    }

    /// The partial carries the slice and NOT a cumulative `text` field: this
    /// producer does not hold the accumulated answer, and inventing one would
    /// make the client's headline lie by a few tokens every frame.
    #[test]
    fn a_partial_carries_the_slice_and_never_a_cumulative_text() {
        let frame = agent_partial_payload(address(), "오르트 구름은", 7, "e1");
        assert_eq!(frame["data"]["type"], json!("agent.partial"));
        assert_eq!(frame["data"]["v"], json!(1));
        let body = &frame["data"]["payload"];
        assert_eq!(body["text_delta"], json!("오르트 구름은"));
        assert!(
            body.get("text").is_none(),
            "the relay does not hold the whole answer: {frame}"
        );
        // A partial decides no state, so it must carry no run_status at all —
        // `applyPartial` would otherwise have two sources for one fact.
        assert!(body.get("run_status").is_none(), "{frame}");
        assert!(body.get("phase").is_none(), "{frame}");
        assert!(frame["idempotency_key"]
            .as_str()
            .expect("key")
            .contains(":agent_partial:"));
    }

    fn address() -> AgentRunAddress {
        AgentRunAddress {
            workspace_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            agent_member_id: Uuid::from_u128(3),
            run_id: Uuid::from_u128(4),
        }
    }
}
