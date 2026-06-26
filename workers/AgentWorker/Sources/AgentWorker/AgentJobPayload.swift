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
    let toolGrants: [ToolGrantMetadata]? // Context Packet / Capability Cache projection
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
        case toolGrants = "tool_grants"
        case contextPacket = "context_packet"
        case contextPacketProjection = "context_packet_projection"
        case maxOutputTokens = "max_output_tokens"
        case stepCount = "step_count"
        case depth
        case consecutiveAuto = "consecutive_auto"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runID = try c.decodeIfPresent(UUID.self, forKey: .runID)
        agentMemberID = try c.decode(UUID.self, forKey: .agentMemberID)
        channelID = try c.decode(UUID.self, forKey: .channelID)
        workspaceID = try c.decodeIfPresent(UUID.self, forKey: .workspaceID)
        model = try c.decode(String.self, forKey: .model)
        prompt = try c.decode(String.self, forKey: .prompt)
        tools = try c.decodeIfPresent(JSONValue.self, forKey: .tools)

        let directToolGrants = try c.decodeIfPresent(
            [ToolGrantMetadata].self, forKey: .toolGrants)
        let contextPacket = try c.decodeIfPresent(
            ToolGrantProjection.self, forKey: .contextPacket)
        let contextProjection = try c.decodeIfPresent(
            ToolGrantProjection.self, forKey: .contextPacketProjection)
        toolGrants = directToolGrants ?? contextPacket?.toolGrants ?? contextProjection?.toolGrants

        maxOutputTokens = try c.decodeIfPresent(Int.self, forKey: .maxOutputTokens)
        stepCount = try c.decodeIfPresent(Int.self, forKey: .stepCount)
        depth = try c.decodeIfPresent(Int.self, forKey: .depth)
        consecutiveAuto = try c.decodeIfPresent(Int.self, forKey: .consecutiveAuto)
    }

    func toolGrant(for toolName: String) -> ToolGrantMetadata? {
        guard let toolGrants else { return nil }
        return ToolGrantMetadata.singleMatch(in: toolGrants, toolName: toolName)
    }
}

struct ToolGrantMetadata: Codable, Equatable, Sendable {
    let toolName: String
    let provider: String?
    let grant: String?
    let risk: String?
    let riskLevel: String?
    let approvalPolicy: String?
    let allowedOperations: [String]?
    let deniedOperations: [String]?
    let inputSchemaRef: String?
    let resourceScopeRef: String?
    let resourceScopeSummary: String?
    let capabilityVersion: String?
    let policyVersion: String?
    let cacheEntryID: String?
    let projectionAuditEventID: String?

    init(
        toolName: String,
        provider: String? = nil,
        grant: String? = nil,
        risk: String? = nil,
        riskLevel: String? = nil,
        approvalPolicy: String? = nil,
        allowedOperations: [String]? = nil,
        deniedOperations: [String]? = nil,
        inputSchemaRef: String? = nil,
        resourceScopeRef: String? = nil,
        resourceScopeSummary: String? = nil,
        capabilityVersion: String? = nil,
        policyVersion: String? = nil,
        cacheEntryID: String? = nil,
        projectionAuditEventID: String? = nil
    ) {
        self.toolName = toolName
        self.provider = provider
        self.grant = grant
        self.risk = risk
        self.riskLevel = riskLevel
        self.approvalPolicy = approvalPolicy
        self.allowedOperations = allowedOperations
        self.deniedOperations = deniedOperations
        self.inputSchemaRef = inputSchemaRef
        self.resourceScopeRef = resourceScopeRef
        self.resourceScopeSummary = resourceScopeSummary
        self.capabilityVersion = capabilityVersion
        self.policyVersion = policyVersion
        self.cacheEntryID = cacheEntryID
        self.projectionAuditEventID = projectionAuditEventID
    }

    enum CodingKeys: String, CodingKey {
        case toolName = "tool_name"
        case provider
        case grant
        case risk
        case riskLevel = "risk_level"
        case approvalPolicy = "approval_policy"
        case allowedOperations = "allowed_operations"
        case deniedOperations = "denied_operations"
        case inputSchemaRef = "input_schema_ref"
        case resourceScopeRef = "resource_scope_ref"
        case resourceScopeSummary = "resource_scope_summary"
        case capabilityVersion = "capability_version"
        case policyVersion = "policy_version"
        case cacheEntryID = "cache_entry_id"
        case projectionAuditEventID = "projection_audit_event_id"
    }

    var effectiveRiskLevel: String? {
        riskLevel ?? risk
    }

    var normalizedToolName: String {
        Self.normalize(toolName)
    }

    var normalizedGrant: String? {
        grant.map(Self.normalize)
    }

    var normalizedRiskLevel: String? {
        effectiveRiskLevel.map(Self.normalize)
    }

    var normalizedApprovalPolicy: String? {
        approvalPolicy.map(Self.normalize)
    }

    var isReadOnlyGrant: Bool {
        normalizedGrant == "read" && normalizedRiskLevel == "read"
    }

    func jsonObject() -> [String: Any] {
        var object: [String: Any] = ["tool_name": toolName]
        if let provider { object["provider"] = provider }
        if let grant { object["grant"] = grant }
        if let effectiveRiskLevel { object["risk_level"] = effectiveRiskLevel }
        if let approvalPolicy { object["approval_policy"] = approvalPolicy }
        if let allowedOperations { object["allowed_operations"] = allowedOperations }
        if let deniedOperations { object["denied_operations"] = deniedOperations }
        if let inputSchemaRef { object["input_schema_ref"] = inputSchemaRef }
        if let resourceScopeRef { object["resource_scope_ref"] = resourceScopeRef }
        if let resourceScopeSummary { object["resource_scope_summary"] = resourceScopeSummary }
        if let capabilityVersion { object["capability_version"] = capabilityVersion }
        if let policyVersion { object["policy_version"] = policyVersion }
        if let cacheEntryID { object["cache_entry_id"] = cacheEntryID }
        if let projectionAuditEventID { object["projection_audit_event_id"] = projectionAuditEventID }
        return object
    }

    static func singleMatch(
        in toolGrants: [ToolGrantMetadata],
        toolName: String
    ) -> ToolGrantMetadata? {
        let normalized = normalize(toolName)
        guard !normalized.isEmpty else { return nil }
        let matches = toolGrants.filter { $0.normalizedToolName == normalized }
        return matches.count == 1 ? matches[0] : nil
    }

    static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
    }
}

private struct ToolGrantProjection: Decodable {
    let toolGrants: [ToolGrantMetadata]

    enum CodingKeys: String, CodingKey {
        case toolGrants = "tool_grants"
    }
}
