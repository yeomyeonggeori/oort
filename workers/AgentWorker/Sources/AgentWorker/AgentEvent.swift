import Foundation

/// Worker-side mirror of the client `AgentEvent` contract (L4 §6.1).
///
/// The transport emits these as it parses the hermes SSE stream; the worker loop
/// turns them into `agent.partial` / `agent.status` Centrifugo publishes. Kept
/// local to this package (no MomoCore dep) so the worker builds standalone —
/// shape matches `clients/Core` AgentEvent.
enum AgentEvent: Sendable {
    case status(RunStatus)
    case textDelta(String)                                   // streaming body
    case toolCall(id: String, name: String, arguments: String)
    case usage(promptTokens: Int, completionTokens: Int, cachedTokens: Int, reasoningTokens: Int)
    case finished(output: String?)
    case error(String)
}

/// Run lifecycle states surfaced on the `agent:` channel via `agent.status`
/// (L4 §5.2). Subset aligned with the `run_status` enum in schema_v0.sql.
enum RunStatus: String, Sendable {
    case queued
    case thinking
    case streaming
    case awaitingApproval = "awaiting_approval"
    case done
    case error
    case cancelled
    case timedOut = "timed_out"
}
