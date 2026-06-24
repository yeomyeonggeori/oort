import Foundation

/// The decoded shape of an `agent_job` outbox row's `payload` column (L4 §3.5).
///
/// Produced by the API/relay when an agent is invoked (e.g. mention, explicit
/// `/invoke`, or A2A hand-off). The dispatch tx writes this alongside the
/// `agent_run` row; `partition_key = agent_member_id` enforces per-agent
/// serialization at claim time.
///
/// Fields beyond the core (model/prompt/ids) are optional gate inputs the worker
/// uses to seed the §3.3 checks without an extra round-trip; the authoritative
/// values live in `agent_run` / `read_state` (DB SoT).
struct AgentJobPayload: Decodable, Sendable {
    let runID: UUID?            // agent_run.id (nil if the run is created by the worker)
    let agentMemberID: UUID     // the agent (member.id) — also the partition key
    let channelID: UUID         // target channel
    let workspaceID: UUID?      // tenant (also on the outbox row)
    let model: String           // OpenAI-compatible model id (agent.model)
    let prompt: String          // user/trigger text
    let tools: JSONValue?       // OpenAI tool/function defs (agent.tool_schema), optional
    let maxOutputTokens: Int?   // reserve estimate basis (§8.5)
    // gate seeds (§3.3 / §3.4)
    let stepCount: Int?
    let depth: Int?
    let consecutiveAuto: Int?

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case agentMemberID = "agent_member_id"
        case channelID = "channel_id"
        case workspaceID = "workspace_id"
        case model
        case prompt
        case tools
        case maxOutputTokens = "max_output_tokens"
        case stepCount = "step_count"
        case depth
        case consecutiveAuto = "consecutive_auto"
    }
}
