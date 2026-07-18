import Foundation
import MomoCore

public struct IOSHuddleParticipant: Codable, Identifiable, Sendable, Hashable {
    public var memberId: MemberID
    public var displayName: String
    public var joinedAtMs: Int64

    public var id: MemberID { memberId }
}

public struct IOSHuddle: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    public var workspaceId: WorkspaceID
    public var channelId: ChannelID
    public var startedBy: MemberID
    public var startedAtMs: Int64
    public var endedAtMs: Int64?
    public var participants: [IOSHuddleParticipant]
}

public struct IOSHuddleJoin: Sendable, Hashable {
    public var huddle: IOSHuddle
    public var liveKitURL: URL
    public var token: String
    public var expiresAt: Date
}

public struct IOSHuddleAudioParticipant: Identifiable, Sendable, Hashable {
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

public enum IOSHuddleState: Sendable, Equatable {
    case idle
    case unavailable
    case connecting
    case permissionDenied
    case joined
    case failed(String)
}

public protocol IOSHuddleService: Sendable {
    func active(workspace: WorkspaceID, channel: ChannelID) async throws -> IOSHuddle?
    func join(workspace: WorkspaceID, huddle: UUID) async throws -> IOSHuddleJoin
    func leave(workspace: WorkspaceID, huddle: UUID) async throws
}

public protocol IOSHuddleAudioSession: Sendable {
    func connect(url: URL, token: String) async throws
    func disconnect() async
    func setMicrophoneMuted(_ muted: Bool) async throws
    func participantUpdates() async -> AsyncStream<[IOSHuddleAudioParticipant]>
}

public protocol IOSMicrophonePermissionAuthorizing: Sendable {
    func requestPermission() async -> Bool
}

enum IOSHuddleClientError: Error, LocalizedError, Sendable {
    case http(Int, String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .http(_, let message): message
        case .invalidResponse: "The huddle server returned an invalid response."
        }
    }

    var isUnconfigured: Bool {
        if case .http(503, _) = self { return true }
        return false
    }
}
