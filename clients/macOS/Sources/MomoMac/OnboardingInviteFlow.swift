import Foundation
import MomoCore

// MARK: - Onboarding invite flow
//
// macOS dev-app only for MOMO-012. The production REST join endpoint is still a
// backend follow-up, so this contract lets LiveChatBackend expose deterministic
// invite-code states without changing the shared MomoCore ChatBackend surface.

public protocol OnboardingInviteBackend: Sendable {
    func joinWorkspace(inviteCode: String) async -> InviteJoinState
    func currentInviteJoinState() async -> InviteJoinState
}

public enum InviteJoinState: Equatable, Sendable {
    case idle
    case validating(code: String)
    case joined(JoinedWorkspace)
    case failed(InviteJoinFailure)

    public var isWorking: Bool {
        if case .validating = self { return true }
        return false
    }
}

public struct JoinedWorkspace: Equatable, Sendable {
    public var workspace: Workspace
    public var role: String
    public var defaultChannelNames: [String]
    public var joinedMemberCount: Int

    public init(
        workspace: Workspace,
        role: String,
        defaultChannelNames: [String],
        joinedMemberCount: Int
    ) {
        self.workspace = workspace
        self.role = role
        self.defaultChannelNames = defaultChannelNames
        self.joinedMemberCount = joinedMemberCount
    }
}

public struct InviteJoinFailure: Equatable, Sendable {
    public var code: String
    public var reason: String
    public var recoveryHint: String?

    public init(code: String, reason: String, recoveryHint: String? = nil) {
        self.code = code
        self.reason = reason
        self.recoveryHint = recoveryHint
    }
}
