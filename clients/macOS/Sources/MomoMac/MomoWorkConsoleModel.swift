import Foundation
import MomoCore

enum MomoWorkTool: String, CaseIterable, Codable, Sendable, Hashable, Identifiable {
    case claude
    case codex
    case opencode
    case shell

    var id: String { rawValue }

    init(_ tool: WorkSessionDelta.Tool) {
        self = MomoWorkTool(rawValue: tool.rawValue) ?? .shell
    }

    var coreValue: WorkSessionDelta.Tool {
        WorkSessionDelta.Tool(rawValue: rawValue) ?? .shell
    }
}

enum MomoWorkSessionStatus: String, Codable, Sendable, Hashable {
    case running
    case ended
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

    var isRunning: Bool { status == .running }

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
}

enum MomoWorkConsoleError: Error, Equatable, Sendable {
    case unavailable
    case noWorkspace
    case noChannel
    case hostIdentityUnavailable
    case hostRegistrationFailed
    case hostHeartbeatFailed
    case executableUnavailable(MomoWorkTool)
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
