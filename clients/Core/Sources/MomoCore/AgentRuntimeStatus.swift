import Foundation

/// User-visible availability for the Kim Intern agent path.
///
/// This is deliberately a redacted projection: clients can show whether the
/// provider path is usable, but never receive provider tokens or raw secret URLs.
public enum AgentAvailability: String, Codable, Sendable, Hashable {
    case available
    case degraded
    case mock
    case unknown
}

public enum AgentProviderMode: String, Codable, Sendable, Hashable {
    case localMock = "local-mock"
    case internalHostMock = "internal-host-mock"
    case externalHermes = "external-hermes"
}

public struct AgentRuntimeStatus: Codable, Sendable, Hashable {
    public var schema: String
    public var agentHandle: String
    public var displayName: String
    public var mode: AgentProviderMode
    public var availability: AgentAvailability
    public var model: String
    public var endpointLabel: String
    public var keyConfigured: Bool
    public var diagnostics: [String]

    public init(
        schema: String = "momo.agent_runtime.status.v0",
        agentHandle: String = "kim-intern",
        displayName: String = "김인턴",
        mode: AgentProviderMode = .localMock,
        availability: AgentAvailability = .unknown,
        model: String = "hermes-agent",
        endpointLabel: String = "not configured",
        keyConfigured: Bool = false,
        diagnostics: [String] = []
    ) {
        self.schema = schema
        self.agentHandle = agentHandle
        self.displayName = displayName
        self.mode = mode
        self.availability = availability
        self.model = model
        self.endpointLabel = endpointLabel
        self.keyConfigured = keyConfigured
        self.diagnostics = diagnostics
    }

    private enum CodingKeys: String, CodingKey {
        case schema
        case agentHandle
        case displayName
        case mode
        case availability
        case model
        case endpointLabel
        case keyConfigured
        case diagnostics
    }

    public static let localMock = AgentRuntimeStatus(
        mode: .localMock,
        availability: .mock,
        endpointLabel: "local mock",
        keyConfigured: true,
        diagnostics: ["local-only mock provider"]
    )
}

public protocol AgentRuntimeStatusProviding: Sendable {
    func agentRuntimeStatus() async throws -> AgentRuntimeStatus
}
