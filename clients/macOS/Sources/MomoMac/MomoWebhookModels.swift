import Combine
import Foundation
import MomoCore

enum MomoWebhookMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case native
    case slackCompatible = "slack_compatible"

    var id: String { rawValue }
}

enum MomoWebhookStatus: String, Codable, Sendable {
    case active
    case revoked
}

struct MomoWebhookInstallation: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    let channelId: ChannelID
    let authorMemberId: MemberID
    let mode: MomoWebhookMode
    let label: String
    let status: MomoWebhookStatus
    let createdAtMs: Int64
    let updatedAtMs: Int64

    var isActive: Bool { status == .active }

    func receiveURL(workspace: WorkspaceID, baseURL: URL) -> URL? {
        guard mode == .native else { return nil }
        return MomoWebhookURLResolver.absoluteReceiveURL(
            path: "/v1/webhooks/\(workspace.description)/\(id.uuidString.lowercased())",
            baseURL: baseURL
        )
    }
}

/// This value is held only while the one-time reveal sheet is presented.
/// It is intentionally not persisted, logged, or included in list models.
struct MomoWebhookOneTimeCredential: Identifiable, Decodable, Equatable, Sendable {
    let installation: MomoWebhookInstallation
    let keyId: UUID
    let secret: String?
    let url: String
    let signatureVersion: String?
    let algorithm: String?
    let overlapSeconds: Int?

    var id: UUID { keyId }

    func receiveURL(baseURL: URL) -> URL? {
        MomoWebhookURLResolver.absoluteReceiveURL(path: url, baseURL: baseURL)
    }
}

struct MomoWebhookCreateRequest: Encodable, Equatable, Sendable {
    let channelId: String
    let mode: MomoWebhookMode
    let label: String
}

struct MomoWebhookRotateRequest: Encodable, Equatable, Sendable {
    let overlapSeconds: Int
}

protocol MomoWebhookClient: Sendable {
    func list(context: MomoInviteAdminContext) async throws -> [MomoWebhookInstallation]

    func create(
        context: MomoInviteAdminContext,
        channel: ChannelID,
        mode: MomoWebhookMode,
        label: String
    ) async throws -> MomoWebhookOneTimeCredential

    func rotate(
        context: MomoInviteAdminContext,
        installation: UUID,
        overlapSeconds: Int
    ) async throws -> MomoWebhookOneTimeCredential

    func revoke(
        context: MomoInviteAdminContext,
        installation: UUID
    ) async throws -> MomoWebhookInstallation
}

enum MomoWebhookClientError: Error, Equatable, LocalizedError, Sendable {
    case offline
    case invalidResponse
    case http(status: Int, message: String)
    case transport

    var errorDescription: String? {
        switch self {
        case .offline:
            return "The webhook server is offline."
        case .invalidResponse:
            return "The server returned an unreadable webhook response."
        case .http(_, let message):
            return message
        case .transport:
            return "The webhook request could not reach the server."
        }
    }
}

enum MomoWebhookLoadState: Equatable {
    case idle
    case loading
    case loaded
    case unavailable
    case offline
    case failed(MomoWebhookUserFailure)
}

enum MomoWebhookOperation: Equatable {
    case idle
    case creating
    case rotating(UUID)
    case revoking(UUID)

    var isWorking: Bool { self != .idle }
}

enum MomoWebhookMutationAction: Equatable {
    case create
    case rotate
    case revoke
}

struct MomoWebhookMutationIssue: Equatable {
    let action: MomoWebhookMutationAction
    let failure: MomoWebhookUserFailure
}

enum MomoWebhookUserFailure: Equatable {
    case invalidLabel
    case unauthorized
    case forbidden
    case conflict
    case invalidResponse
    case offline
    case other

    static func classify(_ error: Error) -> Self {
        if let webhookError = error as? MomoWebhookClientError {
            switch webhookError {
            case .offline, .transport:
                return .offline
            case .invalidResponse:
                return .invalidResponse
            case .http(let status, _):
                switch status {
                case 401: return .unauthorized
                case 403: return .forbidden
                case 409: return .conflict
                default: return .other
                }
            }
        }
        if let urlError = error as? URLError,
           [
               .cannotConnectToHost,
               .cannotFindHost,
               .dnsLookupFailed,
               .networkConnectionLost,
               .notConnectedToInternet,
               .timedOut,
           ].contains(urlError.code)
        {
            return .offline
        }
        return .other
    }
}

enum MomoWebhookNotice: Equatable {
    case receiveURLCopied
    case signingSecretCopied
    case revoked
}

enum MomoWebhookClipboardSensitivity: Equatable {
    case regular
    case secret
}

enum MomoWebhookURLResolver {
    static func absoluteReceiveURL(path: String, baseURL: URL) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              let resolved = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              let base = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let candidate = URLComponents(url: resolved, resolvingAgainstBaseURL: false),
              candidate.scheme?.lowercased() == base.scheme?.lowercased(),
              candidate.host?.lowercased() == base.host?.lowercased(),
              candidate.port == base.port,
              candidate.user == nil,
              candidate.password == nil,
              candidate.query == nil,
              candidate.fragment == nil
        else {
            return nil
        }
        return resolved
    }
}

@MainActor
final class MomoWebhookSettingsModel: ObservableObject {
    typealias CopyValue = @MainActor (String, MomoWebhookClipboardSensitivity) -> Void

    @Published private(set) var loadState: MomoWebhookLoadState = .idle
    @Published private(set) var installations: [MomoWebhookInstallation] = []
    @Published private(set) var operation: MomoWebhookOperation = .idle
    @Published private(set) var oneTimeCredential: MomoWebhookOneTimeCredential?
    @Published private(set) var mutationIssue: MomoWebhookMutationIssue?
    @Published private(set) var notice: MomoWebhookNotice?

    let channelID: ChannelID
    let workspaceID: WorkspaceID

    private var context: MomoInviteAdminContext?
    private var contextGeneration: UInt64 = 0
    private let client: any MomoWebhookClient
    private let copyValue: CopyValue

    init(
        context: MomoInviteAdminContext?,
        channelID: ChannelID,
        workspaceID: WorkspaceID,
        client: any MomoWebhookClient,
        copyValue: @escaping CopyValue
    ) {
        self.context = context
        self.channelID = channelID
        self.workspaceID = workspaceID
        self.client = client
        self.copyValue = copyValue
    }

    var currentChannelInstallations: [MomoWebhookInstallation] {
        installations.filter { $0.channelId == channelID }
    }

    var oneTimeReceiveURL: URL? {
        guard let context, let oneTimeCredential else { return nil }
        return oneTimeCredential.receiveURL(baseURL: context.baseURL)
    }

    var isWorking: Bool { operation.isWorking }

    func updateContext(_ newContext: MomoInviteAdminContext?) async {
        if context != newContext {
            contextGeneration &+= 1
            context = newContext
            installations = []
            operation = .idle
            oneTimeCredential = nil
            mutationIssue = nil
            notice = nil
            loadState = .idle
        }
        await loadIfNeeded()
    }

    func loadIfNeeded() async {
        guard loadState == .idle else { return }
        await load()
    }

    func load() async {
        guard !operation.isWorking else { return }
        guard let context, context.workspace == workspaceID else {
            loadState = .unavailable
            return
        }

        let generation = contextGeneration
        loadState = .loading
        mutationIssue = nil
        do {
            let loadedInstallations = try await client.list(context: context)
            guard generation == contextGeneration, self.context == context else { return }
            installations = loadedInstallations
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard generation == contextGeneration, self.context == context else { return }
            let failure = MomoWebhookUserFailure.classify(error)
            loadState = failure == .offline ? .offline : .failed(failure)
        }
    }

    @discardableResult
    func create(label rawLabel: String, mode: MomoWebhookMode) async -> Bool {
        guard operation == .idle,
              let context,
              context.workspace == workspaceID
        else {
            return false
        }
        let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(label.count),
              !label.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else {
            mutationIssue = MomoWebhookMutationIssue(
                action: .create,
                failure: .invalidLabel
            )
            return false
        }

        let generation = contextGeneration
        operation = .creating
        mutationIssue = nil
        notice = nil
        defer {
            if generation == contextGeneration { operation = .idle }
        }
        do {
            let credential = try await client.create(
                context: context,
                channel: channelID,
                mode: mode,
                label: label
            )
            guard generation == contextGeneration, self.context == context else { return false }
            guard credential.installation.channelId == channelID,
                  credential.installation.mode == mode,
                  credential.installation.isActive
            else {
                throw MomoWebhookClientError.invalidResponse
            }
            upsert(credential.installation)
            oneTimeCredential = credential
            loadState = .loaded
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard generation == contextGeneration, self.context == context else { return false }
            mutationIssue = Self.mutationIssue(action: .create, error: error)
            return false
        }
    }

    @discardableResult
    func rotate(_ installation: MomoWebhookInstallation, overlapSeconds: Int) async -> Bool {
        guard operation == .idle,
              installation.channelId == channelID,
              installation.isActive,
              (0...604_800).contains(overlapSeconds),
              let context,
              context.workspace == workspaceID
        else {
            return false
        }

        let generation = contextGeneration
        operation = .rotating(installation.id)
        mutationIssue = nil
        notice = nil
        defer {
            if generation == contextGeneration { operation = .idle }
        }
        do {
            let credential = try await client.rotate(
                context: context,
                installation: installation.id,
                overlapSeconds: overlapSeconds
            )
            guard generation == contextGeneration, self.context == context else { return false }
            guard credential.installation.id == installation.id,
                  credential.installation.channelId == channelID,
                  credential.installation.mode == installation.mode,
                  credential.installation.isActive
            else {
                throw MomoWebhookClientError.invalidResponse
            }
            upsert(credential.installation)
            oneTimeCredential = credential
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard generation == contextGeneration, self.context == context else { return false }
            mutationIssue = Self.mutationIssue(action: .rotate, error: error)
            return false
        }
    }

    @discardableResult
    func revoke(_ installation: MomoWebhookInstallation) async -> Bool {
        guard operation == .idle,
              installation.channelId == channelID,
              installation.isActive,
              let context,
              context.workspace == workspaceID
        else {
            return false
        }

        let generation = contextGeneration
        operation = .revoking(installation.id)
        mutationIssue = nil
        notice = nil
        defer {
            if generation == contextGeneration { operation = .idle }
        }
        do {
            let revoked = try await client.revoke(
                context: context,
                installation: installation.id
            )
            guard generation == contextGeneration, self.context == context else { return false }
            guard revoked.id == installation.id,
                  revoked.channelId == channelID,
                  revoked.status == .revoked
            else {
                throw MomoWebhookClientError.invalidResponse
            }
            upsert(revoked)
            if oneTimeCredential?.installation.id == installation.id {
                discardOneTimeCredential()
            }
            notice = .revoked
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard generation == contextGeneration, self.context == context else { return false }
            mutationIssue = Self.mutationIssue(action: .revoke, error: error)
            return false
        }
    }

    func discardOneTimeCredential() {
        oneTimeCredential = nil
    }

    @discardableResult
    func copyReceiveURL(for installation: MomoWebhookInstallation) -> Bool {
        guard let context,
              context.workspace == workspaceID,
              let receiveURL = installation.receiveURL(
                workspace: workspaceID,
                baseURL: context.baseURL
              )
        else {
            return false
        }
        copyValue(receiveURL.absoluteString, .regular)
        notice = .receiveURLCopied
        mutationIssue = nil
        return true
    }

    @discardableResult
    func copyOneTimeReceiveURL() -> Bool {
        guard let context,
              context.workspace == workspaceID,
              let credential = oneTimeCredential,
              let receiveURL = credential.receiveURL(baseURL: context.baseURL)
        else {
            return false
        }
        copyValue(
            receiveURL.absoluteString,
            credential.installation.mode == .slackCompatible ? .secret : .regular
        )
        notice = .receiveURLCopied
        mutationIssue = nil
        return true
    }

    @discardableResult
    func copyOneTimeSigningSecret() -> Bool {
        guard let secret = oneTimeCredential?.secret, !secret.isEmpty else { return false }
        copyValue(secret, .secret)
        notice = .signingSecretCopied
        mutationIssue = nil
        return true
    }

    func clearFeedback() {
        mutationIssue = nil
        notice = nil
    }

    private func upsert(_ installation: MomoWebhookInstallation) {
        installations.removeAll { $0.id == installation.id }
        installations.append(installation)
        installations.sort { lhs, rhs in
            if lhs.createdAtMs == rhs.createdAtMs {
                return lhs.id.uuidString < rhs.id.uuidString
            }
            return lhs.createdAtMs > rhs.createdAtMs
        }
    }

    private static func mutationIssue(
        action: MomoWebhookMutationAction,
        error: Error
    ) -> MomoWebhookMutationIssue {
        MomoWebhookMutationIssue(
            action: action,
            failure: MomoWebhookUserFailure.classify(error)
        )
    }
}
