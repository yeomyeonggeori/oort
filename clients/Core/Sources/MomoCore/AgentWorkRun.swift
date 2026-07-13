import Foundation

/// Typed `agent_run.input` convention for ADR-0111 Work v0.
///
/// This is a projection of the existing `agent_run` record, not a second
/// execution object. The server remains authoritative for shape validation and
/// execution stays on the selected BYOA agent host.
public struct AgentWorkInput: Codable, Sendable, Hashable {
    public let type: String
    public var title: String
    public var brief: String
    public var repo: String?
    public var branch: String?

    public init(
        title: String,
        brief: String,
        repo: String? = nil,
        branch: String? = nil
    ) {
        self.type = "work"
        self.title = title
        self.brief = brief
        self.repo = repo
        self.branch = branch
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        guard type == "work" else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "AgentWorkInput requires type=work"
            )
        }
        self.type = type
        self.title = try container.decode(String.self, forKey: .title)
        self.brief = try container.decode(String.self, forKey: .brief)
        self.repo = try container.decodeIfPresent(String.self, forKey: .repo)
        self.branch = try container.decodeIfPresent(String.self, forKey: .branch)
    }
}

/// macOS-facing read projection returned by MOMO-362's Work run endpoints.
/// Ordering inside the channel message ledger still belongs to `Message.seq`;
/// `createdAtMs` only orders Work cards relative to other Work cards.
public struct AgentWorkRun: Identifiable, Codable, Sendable, Hashable {
    public let id: RunID
    public var workspaceId: WorkspaceID
    public var agentMemberId: MemberID
    public var channelId: ChannelID
    public var triggerMessageId: MessageID?
    public var parentRunId: RunID?
    public var status: RunStatus
    public var stepCount: Int
    public var maxSteps: Int
    public var depth: Int
    public var input: AgentWorkInput
    public var output: JSON?
    public var error: JSON?
    public var startedAtMs: Int64?
    public var finishedAtMs: Int64?
    public var createdAtMs: Int64
    public var updatedAtMs: Int64

    public init(
        id: RunID,
        workspaceId: WorkspaceID,
        agentMemberId: MemberID,
        channelId: ChannelID,
        triggerMessageId: MessageID? = nil,
        parentRunId: RunID? = nil,
        status: RunStatus = .queued,
        stepCount: Int = 0,
        maxSteps: Int = 50,
        depth: Int = 0,
        input: AgentWorkInput,
        output: JSON? = nil,
        error: JSON? = nil,
        startedAtMs: Int64? = nil,
        finishedAtMs: Int64? = nil,
        createdAtMs: Int64,
        updatedAtMs: Int64
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.agentMemberId = agentMemberId
        self.channelId = channelId
        self.triggerMessageId = triggerMessageId
        self.parentRunId = parentRunId
        self.status = status
        self.stepCount = stepCount
        self.maxSteps = maxSteps
        self.depth = depth
        self.input = input
        self.output = output
        self.error = error
        self.startedAtMs = startedAtMs
        self.finishedAtMs = finishedAtMs
        self.createdAtMs = createdAtMs
        self.updatedAtMs = updatedAtMs
    }
}

public struct AgentWorkRunPage: Codable, Sendable, Hashable {
    public var runs: [AgentWorkRun]

    public init(runs: [AgentWorkRun]) {
        self.runs = runs
    }
}

public struct CreateAgentWorkRunRequest: Codable, Sendable, Hashable {
    public var agentMemberId: MemberID
    public var clientRunId: UUID
    public var input: AgentWorkInput

    public init(agentMemberId: MemberID, clientRunId: UUID, input: AgentWorkInput) {
        self.agentMemberId = agentMemberId
        self.clientRunId = clientRunId
        self.input = input
    }
}

/// Optional backend capability for Work v0. Chat backends that do not implement
/// ADR-0111 remain valid; the macOS composer then presents an unavailable state.
public protocol AgentWorkRunBackend: Sendable {
    func createWorkRun(
        agent: MemberID,
        channel: ChannelID,
        input: AgentWorkInput,
        clientRunId: UUID
    ) async throws -> AgentWorkRun

    func workRuns(channel: ChannelID, limit: Int) async throws -> [AgentWorkRun]

    func workRun(id: RunID) async throws -> AgentWorkRun
}
