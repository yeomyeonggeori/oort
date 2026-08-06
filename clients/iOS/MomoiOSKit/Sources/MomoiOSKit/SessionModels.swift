import Foundation
import MomoCore

public struct SessionForm: Codable, Equatable, Sendable {
    public var serverURL: String
    public var email: String
    public var password: String
    public var inviteCode: String

    public init(
        serverURL: String = "http://127.0.0.1:28180",
        email: String = "demo@momo.local",
        password: String = "dev-password",
        inviteCode: String = ""
    ) {
        self.serverURL = serverURL
        self.email = email
        self.password = password
        self.inviteCode = inviteCode
    }

    public var trimmedInviteCode: String {
        inviteCode.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var submitsInvite: Bool { !trimmedInviteCode.isEmpty }

    public func validated() throws -> ValidatedSessionForm {
        let trimmedServerURL = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let baseURL = URL(string: trimmedServerURL),
              let scheme = baseURL.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              baseURL.host != nil
        else {
            throw SessionError.validation("Enter a server URL like http://127.0.0.1:28180.")
        }

        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedEmail.contains("@"), trimmedEmail.contains(".") else {
            throw SessionError.validation("Enter the email used by your oort workspace.")
        }
        guard !password.isEmpty else {
            throw SessionError.validation("Enter your password.")
        }

        return ValidatedSessionForm(
            baseURL: baseURL,
            email: trimmedEmail,
            password: password,
            inviteCode: trimmedInviteCode
        )
    }
}

public struct ValidatedSessionForm: Equatable, Sendable {
    public let baseURL: URL
    public let email: String
    public let password: String
    public let inviteCode: String
}

public struct IOSSession: Codable, Equatable, Sendable {
    public var baseURL: URL
    public var workspaceID: WorkspaceID
    public var member: Member
    public var accessToken: String
    public var refreshToken: String
    public var realtimeWebSocketURL: URL?
    public var email: String

    public init(
        baseURL: URL,
        workspaceID: WorkspaceID,
        member: Member,
        accessToken: String,
        refreshToken: String,
        realtimeWebSocketURL: URL?,
        email: String
    ) {
        self.baseURL = baseURL
        self.workspaceID = workspaceID
        self.member = member
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.realtimeWebSocketURL = realtimeWebSocketURL
        self.email = email
    }
}

public struct WorkspaceBootstrap: Codable, Equatable, Sendable {
    public var workspace: Workspace
    public var channels: [Channel]

    public init(workspace: Workspace, channels: [Channel]) {
        self.workspace = workspace
        self.channels = channels
    }
}

public enum SessionError: LocalizedError, Equatable, Sendable {
    case validation(String)
    case server(status: Int, message: String)
    case decoding(String)
    case transport(String)
    case sessionExpired
    case secureStorage

    public var errorDescription: String? {
        switch self {
        case .validation(let message), .decoding(let message), .transport(let message):
            return message
        case .server(_, let message):
            return message
        case .sessionExpired:
            return "Your session expired. Sign in again to continue."
        case .secureStorage:
            return "Your session could not be stored securely. Sign in again."
        }
    }
}
