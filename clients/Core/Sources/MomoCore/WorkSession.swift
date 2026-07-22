/// Channel projection for the host-owned session lifecycle in ADR-0114.
/// The server stores only this durable label/lifecycle metadata; cwd, paths,
/// process state, terminal output, and provider credentials remain host-local.
public struct WorkSessionDelta: Codable, Sendable, Hashable {
    public enum Action: String, Codable, Sendable, Hashable {
        case started, ended
    }

    public struct Tool: RawRepresentable, Codable, Sendable, Hashable {
        public let rawValue: String

        public init(rawValue: String) {
            self.rawValue = rawValue
        }

        public static let claude = Tool(rawValue: "claude")
        public static let codex = Tool(rawValue: "codex")
        public static let opencode = Tool(rawValue: "opencode")
        public static let shell = Tool(rawValue: "shell")

        public init(from decoder: any Decoder) throws {
            let container = try decoder.singleValueContainer()
            self.init(rawValue: try container.decode(String.self))
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }
    }

    public var action: Action
    public var sessionId: WorkSessionID
    public var channelId: ChannelID
    public var rootMessageId: MessageID
    public var memberId: MemberID
    public var hostId: WorkHostID
    public var tool: Tool
    public var label: String
    public var startedAtMs: Int64?
    public var endedAtMs: Int64?
    public var exitCode: Int?

    public init(
        action: Action,
        sessionId: WorkSessionID,
        channelId: ChannelID,
        rootMessageId: MessageID,
        memberId: MemberID,
        hostId: WorkHostID,
        tool: Tool,
        label: String,
        startedAtMs: Int64? = nil,
        endedAtMs: Int64? = nil,
        exitCode: Int? = nil
    ) {
        self.action = action
        self.sessionId = sessionId
        self.channelId = channelId
        self.rootMessageId = rootMessageId
        self.memberId = memberId
        self.hostId = hostId
        self.tool = tool
        self.label = label
        self.startedAtMs = startedAtMs
        self.endedAtMs = endedAtMs
        self.exitCode = exitCode
    }

    private enum CodingKeys: String, CodingKey {
        case action
        case sessionId = "session_id"
        case channelId = "channel_id"
        case rootMessageId = "root_message_id"
        case memberId = "member_id"
        case hostId = "host_id"
        case tool, label
        case startedAtMs = "started_at"
        case endedAtMs = "ended_at"
        case exitCode = "exit_code"
    }
}
