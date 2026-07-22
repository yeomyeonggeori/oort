import Foundation
import MomoCore

struct MomoWorkTool: RawRepresentable, Codable, Sendable, Hashable, Identifiable {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue.lowercased()
    }

    static let claude = MomoWorkTool(rawValue: "claude")
    static let codex = MomoWorkTool(rawValue: "codex")
    static let opencode = MomoWorkTool(rawValue: "opencode")
    static let shell = MomoWorkTool(rawValue: "shell")

    var id: String { rawValue }

    init(_ tool: WorkSessionDelta.Tool) {
        self = MomoWorkTool(rawValue: tool.rawValue)
    }

    var coreValue: WorkSessionDelta.Tool {
        WorkSessionDelta.Tool(rawValue: rawValue)
    }

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(rawValue: try container.decode(String.self))
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

enum MomoWorkTransport: String, Codable, Sendable, Hashable, CaseIterable, Identifiable {
    case pty
    case acp

    var id: String { rawValue }
}

enum MomoWorkToolPermissionPolicy: String, Codable, Sendable, Hashable, CaseIterable, Identifiable {
    case confirm
    case allow
    case deny

    var id: String { rawValue }
}

enum MomoWorkToolRisk: String, Codable, Sendable, Hashable, CaseIterable, Identifiable {
    case low
    case medium
    case high

    var id: String { rawValue }
}

struct MomoWorkToolLaunchTemplate: Codable, Sendable, Hashable {
    var command: String
    var arguments: [String]
}

struct MomoWorkToolProfile: Identifiable, Codable, Sendable, Hashable {
    let id: UUID
    let workspaceId: WorkspaceID
    let toolKey: String
    var displayName: String
    var launchTemplate: MomoWorkToolLaunchTemplate
    var tierDefaults: [String: JSON]
    var enabled: Bool
    let createdBy: MemberID
    let updatedBy: MemberID
    let createdAtMs: Int64
    let updatedAtMs: Int64

    var tool: MomoWorkTool { MomoWorkTool(rawValue: toolKey) }
    var transport: MomoWorkTransport {
        guard case .string(let raw)? = tierDefaults["transport"] else { return .pty }
        return MomoWorkTransport(rawValue: raw) ?? .pty
    }
    var permissionPolicy: MomoWorkToolPermissionPolicy {
        guard case .string(let raw)? = tierDefaults["permission_policy"] else { return .confirm }
        return MomoWorkToolPermissionPolicy(rawValue: raw) ?? .confirm
    }
    var risk: MomoWorkToolRisk {
        guard case .string(let raw)? = tierDefaults["risk"] else { return .medium }
        return MomoWorkToolRisk(rawValue: raw) ?? .medium
    }
}

struct MomoWorkToolProfileDraft: Sendable, Hashable {
    var toolKey: String
    var displayName: String
    var command: String
    var arguments: [String]
    var transport: MomoWorkTransport
    var permissionPolicy: MomoWorkToolPermissionPolicy
    var risk: MomoWorkToolRisk
    var enabled: Bool
}

enum MomoWorkSessionStatus: String, Codable, Sendable, Hashable {
    case running
    case orphaned
    case ended
}

enum MomoWorkSessionEndReason: String, Codable, Sendable, Hashable {
    case orphaned
    case resumed
}

enum MomoWorkTierPolicyMode: String, CaseIterable, Codable, Sendable, Hashable, Identifiable {
    case t1Only = "t1_only"
    case ask
    case auto

    var id: String { rawValue }
}

enum MomoWorkTierPolicyScope: Sendable, Hashable {
    case workspace
    case member
}

struct MomoWorkTierPolicy: Codable, Sendable, Hashable {
    let workspaceId: WorkspaceID
    let memberId: MemberID?
    let mode: MomoWorkTierPolicyMode
    let autoTarget: String?
    let inherited: Bool
    let updatedAtMs: Int64?
}

enum MomoWorkSessionObservation: String, Codable, Sendable, Hashable {
    case open
    case ownerOnly = "owner_only"
}

enum MomoTerminalAttachMode: String, Codable, Sendable, Hashable {
    case controller
    case observer
}

enum MomoTerminalAttachPolicy {
    static func mode(
        for session: MomoWorkSession,
        currentMemberID: MemberID?,
        hasLocalTerminal: Bool
    ) -> MomoTerminalAttachMode? {
        guard session.isRunning,
              !hasLocalTerminal,
              session.isRemotePTYBound,
              let currentMemberID else { return nil }
        if session.memberId == currentMemberID { return .controller }
        guard session.observation == .open else { return nil }
        return .observer
    }
}

struct MomoWorkSession: Identifiable, Codable, Sendable, Hashable {
    let id: WorkSessionID
    let workspaceId: WorkspaceID
    let channelId: ChannelID
    let memberId: MemberID
    let hostId: WorkHostID
    let rootMessageId: MessageID
    let tool: MomoWorkTool
    let label: String
    var status: MomoWorkSessionStatus
    let startedAtMs: Int64
    var endedAtMs: Int64?
    var exitCode: Int?
    var endReason: MomoWorkSessionEndReason?
    let resumedFromSessionId: WorkSessionID?
    let ptyId: String?
    let remoteAttachAvailable: Bool?
    var observation: MomoWorkSessionObservation?
    var observerGrantCount: Int64?

    var isRunning: Bool { status == .running }
    var isOrphaned: Bool { status == .orphaned }
    var isRemotePTYBound: Bool { remoteAttachAvailable == true || ptyId != nil }

    init(
        id: WorkSessionID,
        workspaceId: WorkspaceID,
        channelId: ChannelID,
        memberId: MemberID,
        hostId: WorkHostID,
        rootMessageId: MessageID,
        tool: MomoWorkTool,
        label: String,
        status: MomoWorkSessionStatus,
        startedAtMs: Int64,
        endedAtMs: Int64? = nil,
        exitCode: Int? = nil,
        endReason: MomoWorkSessionEndReason? = nil,
        resumedFromSessionId: WorkSessionID? = nil,
        ptyId: String? = nil,
        remoteAttachAvailable: Bool? = nil,
        observation: MomoWorkSessionObservation? = .open,
        observerGrantCount: Int64? = 0
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.channelId = channelId
        self.memberId = memberId
        self.hostId = hostId
        self.rootMessageId = rootMessageId
        self.tool = tool
        self.label = label
        self.status = status
        self.startedAtMs = startedAtMs
        self.endedAtMs = endedAtMs
        self.exitCode = exitCode
        self.endReason = endReason
        self.resumedFromSessionId = resumedFromSessionId
        self.ptyId = ptyId
        self.remoteAttachAvailable = remoteAttachAvailable
        self.observation = observation
        self.observerGrantCount = observerGrantCount
    }

    mutating func apply(_ delta: WorkSessionDelta) {
        guard id == delta.sessionId else { return }
        status = delta.action == .started ? .running : .ended
        endedAtMs = delta.endedAtMs
        exitCode = delta.exitCode
    }
}

struct MomoWorkConsoleRealtimeEvent: Identifiable, Hashable {
    enum Payload: Hashable {
        case session(WorkSessionDelta)
        case control(WorkControlDelta)
        case projectionRefresh(WorkSessionID)
    }

    let id = UUID()
    let payload: Payload
}

extension WorkHost {
    var momoIsActiveAppHost: Bool {
        scope == .member && type == .app && !isRevoked
    }

    func momoWithOnline(_ online: Bool) -> WorkHost {
        var copy = self
        copy.online = online
        return copy
    }
}

enum MomoWorkHostRegistrationState: Equatable {
    case waitingForSession
    case registering
    case ready(WorkHost)
    case failed(MomoWorkConsoleError)

    var host: WorkHost? {
        guard case .ready(let host) = self else { return nil }
        return host
    }
}

enum MomoWorkAutoApproveState: Equatable {
    case unknown
    case updating
    case enabled
    case disabled
    case failed
}

protocol MomoWorkConsoleBackend: Sendable {
    func workSessions(
        workspace: WorkspaceID,
        activeOnly: Bool
    ) async throws -> [MomoWorkSession]

    func createWorkSession(
        workspace: WorkspaceID,
        channel: ChannelID,
        host: WorkHostID,
        tool: MomoWorkTool,
        label: String
    ) async throws -> MomoWorkSession

    func endWorkSession(
        workspace: WorkspaceID,
        session: WorkSessionID,
        exitCode: Int?
    ) async throws -> MomoWorkSession

    func issueTerminalAttach(
        workspace: WorkspaceID,
        session: WorkSessionID,
        mode: MomoTerminalAttachMode
    ) async throws -> MomoTerminalAttachGrant

    func setWorkSessionObservation(
        workspace: WorkspaceID,
        session: WorkSessionID,
        observation: MomoWorkSessionObservation
    ) async throws -> MomoWorkSession

    func resumeWorkSession(
        workspace: WorkspaceID,
        session: WorkSessionID,
        targetHost: WorkHostID
    ) async throws -> MomoWorkSession

    func workTierPolicy(
        workspace: WorkspaceID,
        scope: MomoWorkTierPolicyScope
    ) async throws -> MomoWorkTierPolicy

    func setWorkTierPolicy(
        workspace: WorkspaceID,
        scope: MomoWorkTierPolicyScope,
        mode: MomoWorkTierPolicyMode,
        autoTarget: String?
    ) async throws -> MomoWorkTierPolicy

    func acknowledgeWorkControl(
        workspace: WorkspaceID,
        control: WorkControlID,
        ok: Bool,
        session: WorkSessionID?,
        errorLabel: String?
    ) async throws

    func setWorkAutoApprove(
        workspace: WorkspaceID,
        tool: MomoWorkTool,
        enabled: Bool
    ) async throws -> Bool

    func workToolProfiles(workspace: WorkspaceID) async throws -> [MomoWorkToolProfile]

    func createWorkToolProfile(
        workspace: WorkspaceID,
        draft: MomoWorkToolProfileDraft
    ) async throws -> MomoWorkToolProfile

    func updateWorkToolProfile(
        workspace: WorkspaceID,
        tool: MomoWorkTool,
        draft: MomoWorkToolProfileDraft
    ) async throws -> MomoWorkToolProfile

    func deleteWorkToolProfile(
        workspace: WorkspaceID,
        tool: MomoWorkTool
    ) async throws -> MomoWorkToolProfile
}

extension MomoWorkConsoleBackend {
    func issueTerminalAttach(
        workspace: WorkspaceID,
        session: WorkSessionID
    ) async throws -> MomoTerminalAttachGrant {
        try await issueTerminalAttach(
            workspace: workspace,
            session: session,
            mode: .controller
        )
    }

    func workToolProfiles(workspace: WorkspaceID) async throws -> [MomoWorkToolProfile] {
        throw MomoWorkConsoleError.toolProfileUnavailable
    }

    func createWorkToolProfile(
        workspace: WorkspaceID,
        draft: MomoWorkToolProfileDraft
    ) async throws -> MomoWorkToolProfile {
        throw MomoWorkConsoleError.toolProfileUnavailable
    }

    func updateWorkToolProfile(
        workspace: WorkspaceID,
        tool: MomoWorkTool,
        draft: MomoWorkToolProfileDraft
    ) async throws -> MomoWorkToolProfile {
        throw MomoWorkConsoleError.toolProfileUnavailable
    }

    func deleteWorkToolProfile(
        workspace: WorkspaceID,
        tool: MomoWorkTool
    ) async throws -> MomoWorkToolProfile {
        throw MomoWorkConsoleError.toolProfileUnavailable
    }
}

protocol MomoWorkHostBackend: Sendable {
    func workHosts(workspace: WorkspaceID) async throws -> [WorkHost]

    func registerWorkHost(
        workspace: WorkspaceID,
        displayName: String,
        publicKey: String,
        capabilities: [String: Bool]
    ) async throws -> WorkHost

    func heartbeatWorkHost(
        workspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        signature: String
    ) async throws -> WorkHost

    func enabledWorkToolProfiles(
        workspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        signature: String
    ) async throws -> [MomoWorkToolProfile]
}

extension MomoWorkHostBackend {
    func enabledWorkToolProfiles(
        workspace: WorkspaceID,
        host: WorkHostID,
        sentAtMs: Int64,
        signature: String
    ) async throws -> [MomoWorkToolProfile] {
        throw MomoWorkConsoleError.toolProfileUnavailable
    }
}

enum MomoWorkConsoleError: Error, Equatable, Sendable {
    case unavailable
    case noWorkspace
    case noChannel
    case hostIdentityUnavailable
    case hostRegistrationFailed
    case hostHeartbeatFailed
    case executableUnavailable(MomoWorkTool)
    case toolProfileUnavailable
    case sandboxRestricted
    case localLaunchFailed
    case sessionUnavailable
    case excerptEmpty
    case excerptSendFailed

    func message(copy: MomoWorkspaceCopy) -> String {
        switch (self, copy.language) {
        case (.unavailable, .korean):
            return "이 서버에서는 Work Console을 사용할 수 없습니다."
        case (.unavailable, .english):
            return "Work Console is unavailable on this server."
        case (.noWorkspace, .korean):
            return "워크스페이스 연결을 먼저 완료하세요."
        case (.noWorkspace, .english):
            return "Connect to a workspace first."
        case (.noChannel, .korean):
            return "세션 카드를 남길 채널을 먼저 선택하세요."
        case (.noChannel, .english):
            return "Select a channel for the session card first."
        case (.hostIdentityUnavailable, .korean):
            return "이 Mac의 안전한 Work 신원을 준비하지 못했습니다."
        case (.hostIdentityUnavailable, .english):
            return "A secure Work identity could not be prepared on this Mac."
        case (.hostRegistrationFailed, .korean):
            return "호스트 등록에 실패했습니다. 등록 전에는 Work Console을 시작할 수 없습니다."
        case (.hostRegistrationFailed, .english):
            return "Host registration failed. Work Console stays unavailable until registration succeeds."
        case (.hostHeartbeatFailed, .korean):
            return "호스트 연결 상태를 확인하지 못했습니다. 등록은 유지되며 다시 확인합니다."
        case (.hostHeartbeatFailed, .english):
            return "Host presence could not be confirmed. Registration remains active and will be checked again."
        case (.toolProfileUnavailable, .korean):
            return "등록되고 활성화된 도구 프로파일이 필요합니다."
        case (.toolProfileUnavailable, .english):
            return "A registered and enabled tool profile is required."
        case (.executableUnavailable(let tool), .korean):
            return "이 Mac에서 \(tool.rawValue) 실행 파일을 찾지 못했습니다."
        case (.executableUnavailable(let tool), .english):
            return "The \(tool.rawValue) executable was not found on this Mac."
        case (.sandboxRestricted, .korean):
            return "이 앱 빌드는 macOS App Sandbox 안에서 실행 중이라 로컬 CLI를 시작할 수 없습니다."
        case (.sandboxRestricted, .english):
            return "This app build runs inside macOS App Sandbox and cannot start local CLI tools."
        case (.localLaunchFailed, .korean):
            return "로컬 터미널 프로세스를 시작하지 못했습니다."
        case (.localLaunchFailed, .english):
            return "The local terminal process could not be started."
        case (.sessionUnavailable, .korean):
            return "이 세션의 로컬 터미널에 연결할 수 없습니다."
        case (.sessionUnavailable, .english):
            return "The local terminal for this session is unavailable."
        case (.excerptEmpty, .korean):
            return "공유할 발췌 내용이 없습니다."
        case (.excerptEmpty, .english):
            return "There is no excerpt to share."
        case (.excerptSendFailed, .korean):
            return "발췌를 세션 스레드에 보내지 못했습니다."
        case (.excerptSendFailed, .english):
            return "The excerpt could not be sent to the session thread."
        }
    }
}
