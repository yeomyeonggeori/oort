import Foundation
import MomoCore

public struct MomoHuddleParticipant: Codable, Identifiable, Sendable, Hashable {
    public var memberId: MemberID
    public var displayName: String
    public var joinedAtMs: Int64

    public var id: MemberID { memberId }
}

public struct MomoHuddle: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    public var workspaceId: WorkspaceID
    public var channelId: ChannelID
    public var startedBy: MemberID
    public var startedAtMs: Int64
    public var endedAtMs: Int64?
    public var participants: [MomoHuddleParticipant]
}

public struct MomoHuddleJoin: Sendable, Hashable {
    public var huddle: MomoHuddle
    public var liveKitURL: URL
    public var token: String
    public var expiresAt: Date
}

public struct MomoHuddleAudioParticipant: Identifiable, Sendable, Hashable {
    public var id: String
    public var displayName: String
    public var isSpeaking: Bool
    public var isLocal: Bool

    public init(id: String, displayName: String, isSpeaking: Bool, isLocal: Bool) {
        self.id = id
        self.displayName = displayName
        self.isSpeaking = isSpeaking
        self.isLocal = isLocal
    }
}

public enum MomoHuddleState: Sendable, Equatable {
    case idle
    case unavailable(String)
    case connecting
    case joined
    case failed(String)
}

public protocol MomoHuddleService: Sendable {
    func active(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle?
    func start(workspace: WorkspaceID, channel: ChannelID) async throws -> MomoHuddle
    func join(workspace: WorkspaceID, huddle: UUID) async throws -> MomoHuddleJoin
    func leave(workspace: WorkspaceID, huddle: UUID) async throws
    func events(workspace: WorkspaceID, channel: ChannelID) async throws -> AsyncStream<HuddleDelta>
}

public protocol MomoHuddleAudioSession: Sendable {
    func connect(url: URL, token: String) async throws
    func disconnect() async
    func setMicrophoneMuted(_ muted: Bool) async throws
    func participantUpdates() async -> AsyncStream<[MomoHuddleAudioParticipant]>
}

enum MomoHuddleClientError: Error, LocalizedError, Sendable {
    case unavailable(String)
    case http(Int, String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unavailable(let reason): reason
        case .http(_, let message): message
        case .invalidResponse: "The huddle server returned an invalid response."
        }
    }

    var isUnconfigured: Bool {
        switch self {
        case .http(503, _), .unavailable: true
        default: false
        }
    }
}
