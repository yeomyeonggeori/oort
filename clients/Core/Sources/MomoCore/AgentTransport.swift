import Foundation

/// The shared agent transport contract (L4 §6.1). Implemented in the platform apps
/// over the `agent:` Centrifugo namespace (observe) + REST (invoke/decide/cancel).
///
/// Agents are first-class members; invocation is the same REST/idempotency path as
/// human sends. Side-effecting tool calls always pass the human approval gate (G6).
public protocol AgentTransport: Sendable {
    /// Subscribe to an agent's first-class work stream on a channel and render
    /// partials (status / text deltas / tool calls / approval requests).
    func observe(agent: MemberID, channel: ChannelID) async throws -> AsyncStream<AgentEvent>

    /// Explicitly invoke an agent in a channel with a prompt. `idempotencyKey`
    /// dedupes retries (a trigger produces at most one live run). Returns the run id.
    func invoke(
        agent: MemberID,
        channel: ChannelID,
        prompt: String,
        idempotencyKey: UUID
    ) async throws -> RunID

    /// Approve or reject a pending approval (G6 gate, demo C).
    func decideApproval(_ id: ApprovalID, approve: Bool, reason: String?) async throws

    /// Cancel an in-flight run.
    func cancelRun(_ id: RunID) async throws
}
