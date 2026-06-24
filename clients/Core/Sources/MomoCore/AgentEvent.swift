import Foundation

/// Events streamed from an agent's work on a channel (L4 §6.1).
/// Observed via `AgentTransport.observe(agent:channel:)`; renders the first-class
/// agent message stream (tool-call cards, streaming text, approval gates).
public enum AgentEvent: Sendable, Hashable {
    /// Run state-machine transition (L4 §6.1).
    case status(RunID, RunStatus)
    /// Streaming body delta (agent.partial first-class render).
    case textDelta(RunID, String)
    /// A tool invocation started (demo D: live tool-call card).
    case toolCall(RunID, name: String, args: JSON)
    /// A tool returned a result.
    case toolResult(RunID, callId: String, output: JSON, isError: Bool)
    /// A human-in-the-loop approval is required before proceeding (G6, demo C).
    case approvalRequest(ApprovalID, action: String, payload: JSON)
    /// The run finished with an optional output payload.
    case finished(RunID, output: JSON?)
    /// The run errored.
    case error(RunID, JSON)
}
