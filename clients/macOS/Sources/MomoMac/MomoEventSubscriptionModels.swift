import Combine
import Foundation
import MomoCore

enum MomoEventSubscriptionKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case mention
    case approvalRequest = "approval_request"
    case workStatusChanged = "work.status_changed"

    var id: String { rawValue }
}

enum MomoEventSubscriptionDisabledReason: String, Codable, Sendable {
    case disabledByAdmin = "disabled_by_admin"
    case serverFailureThreshold = "server_5xx_threshold"
}

enum MomoEventSubscriptionStatus: Equatable, Sendable {
    case enabled
    case disabledByAdmin
    case disabledAfterFailures
    case unavailable
}

struct MomoEventSubscription: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    let workspaceId: WorkspaceID
    let url: String
    let eventKinds: [MomoEventSubscriptionKind]
    let enabled: Bool
    let deliveryFailureCount: Int
    let disabledAtMs: Int64?
    let disabledReason: MomoEventSubscriptionDisabledReason?
    let createdBy: MemberID
    let updatedBy: MemberID
    let createdAtMs: Int64
    let updatedAtMs: Int64

    var status: MomoEventSubscriptionStatus {
        if enabled { return .enabled }
        switch disabledReason {
        case .disabledByAdmin: return .disabledByAdmin
        case .serverFailureThreshold: return .disabledAfterFailures
        case nil: return .unavailable
        }
    }
}

/// Kept only while the one-time secret sheet is visible. List and update
/// responses decode into `MomoEventSubscription`, which has no secret field.
struct MomoEventSubscriptionSecret: Identifiable, Decodable, Equatable, Sendable {
    let eventSubscription: MomoEventSubscription
    let secret: String
    let signatureVersion: String
    let algorithm: String

    var id: UUID { eventSubscription.id }
}

struct MomoEventSubscriptionCreateRequest: Encodable, Equatable, Sendable {
    let url: String
    let eventKinds: [MomoEventSubscriptionKind]
    let enabled: Bool
}

struct MomoEventSubscriptionUpdateRequest: Encodable, Equatable, Sendable {
    let enabled: Bool
}

protocol MomoEventSubscriptionClient: Sendable {
    func list(context: MomoInviteAdminContext) async throws -> [MomoEventSubscription]
    func create(
        context: MomoInviteAdminContext,
        url: String,
        eventKinds: [MomoEventSubscriptionKind]
    ) async throws -> MomoEventSubscriptionSecret
    func setEnabled(
        context: MomoInviteAdminContext,
        subscription: UUID,
        enabled: Bool
    ) async throws -> MomoEventSubscription
    func delete(
        context: MomoInviteAdminContext,
        subscription: UUID
    ) async throws -> MomoEventSubscription
}

enum MomoEventSubscriptionClientError: Error, Equatable, Sendable {
    case offline
    case invalidResponse
    case http(Int)
    case transport
}

enum MomoEventSubscriptionLoadState: Equatable {
    case idle
    case loading
    case loaded
    case unavailable
    case offline
    case failed(MomoEventSubscriptionFailure)
}

enum MomoEventSubscriptionFailure: Equatable {
    case invalidURL
    case noEvents
    case unauthorized
    case forbidden
    case notFound
    case invalidResponse
    case offline
    case other

    static func classify(_ error: Error) -> Self {
        if let clientError = error as? MomoEventSubscriptionClientError {
            switch clientError {
            case .offline, .transport: return .offline
            case .invalidResponse: return .invalidResponse
            case .http(let status):
                switch status {
                case 401: return .unauthorized
                case 403: return .forbidden
                case 404: return .notFound
                default: return .other
                }
            }
        }
        return .other
    }
}

enum MomoEventSubscriptionOperation: Equatable {
    case idle
    case creating
    case updating(UUID)
    case deleting(UUID)

    var isWorking: Bool { self != .idle }
}

enum MomoEventSubscriptionMutation: Equatable {
    case create
    case enable
    case disable
    case delete
}

struct MomoEventSubscriptionIssue: Equatable {
    let mutation: MomoEventSubscriptionMutation
    let failure: MomoEventSubscriptionFailure
}

@MainActor
final class MomoEventSubscriptionSettingsModel: ObservableObject {
    typealias CopySecret = @MainActor (String) -> Void

    @Published private(set) var loadState: MomoEventSubscriptionLoadState = .idle
    @Published private(set) var subscriptions: [MomoEventSubscription] = []
    @Published private(set) var operation: MomoEventSubscriptionOperation = .idle
    @Published private(set) var oneTimeSecret: MomoEventSubscriptionSecret?
    @Published private(set) var mutationIssue: MomoEventSubscriptionIssue?
    @Published private(set) var copiedSecret = false

    let workspaceID: WorkspaceID
    private var context: MomoInviteAdminContext?
    private var generation: UInt64 = 0
    private let client: any MomoEventSubscriptionClient
    private let copySecretValue: CopySecret

    init(
        context: MomoInviteAdminContext?,
        workspaceID: WorkspaceID,
        client: any MomoEventSubscriptionClient,
        copySecret: @escaping CopySecret
    ) {
        self.context = context
        self.workspaceID = workspaceID
        self.client = client
        self.copySecretValue = copySecret
    }

    var isWorking: Bool { operation.isWorking }

    func updateContext(_ newContext: MomoInviteAdminContext?) async {
        if context != newContext {
            generation &+= 1
            context = newContext
            subscriptions = []
            operation = .idle
            oneTimeSecret = nil
            mutationIssue = nil
            copiedSecret = false
            loadState = .idle
        }
        guard loadState == .idle else { return }
        await load()
    }

    func load() async {
        guard operation == .idle else { return }
        guard let context, context.workspace == workspaceID else {
            loadState = .unavailable
            return
        }
        let currentGeneration = generation
        loadState = .loading
        mutationIssue = nil
        do {
            let values = try await client.list(context: context)
            guard currentGeneration == generation, self.context == context else { return }
            guard values.allSatisfy({ $0.workspaceId == workspaceID }) else {
                throw MomoEventSubscriptionClientError.invalidResponse
            }
            subscriptions = Self.sorted(values)
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard currentGeneration == generation, self.context == context else { return }
            let failure = MomoEventSubscriptionFailure.classify(error)
            loadState = failure == .offline ? .offline : .failed(failure)
        }
    }

    @discardableResult
    func create(url rawURL: String, eventKinds: Set<MomoEventSubscriptionKind>) async -> Bool {
        guard operation == .idle, let context, context.workspace == workspaceID else { return false }
        guard let url = Self.normalizedURL(rawURL) else {
            mutationIssue = .init(mutation: .create, failure: .invalidURL)
            return false
        }
        guard !eventKinds.isEmpty else {
            mutationIssue = .init(mutation: .create, failure: .noEvents)
            return false
        }
        let kinds = eventKinds.sorted { $0.rawValue < $1.rawValue }
        let currentGeneration = generation
        operation = .creating
        mutationIssue = nil
        copiedSecret = false
        defer { if currentGeneration == generation { operation = .idle } }
        do {
            let result = try await client.create(context: context, url: url, eventKinds: kinds)
            guard currentGeneration == generation, self.context == context else { return false }
            guard result.eventSubscription.workspaceId == workspaceID,
                  result.eventSubscription.enabled,
                  Self.normalizedURL(result.eventSubscription.url) != nil,
                  Set(result.eventSubscription.eventKinds) == eventKinds,
                  !result.secret.isEmpty,
                  result.signatureVersion == "v1",
                  result.algorithm == "HMAC-SHA256"
            else {
                throw MomoEventSubscriptionClientError.invalidResponse
            }
            upsert(result.eventSubscription)
            oneTimeSecret = result
            loadState = .loaded
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard currentGeneration == generation, self.context == context else { return false }
            mutationIssue = .init(mutation: .create, failure: .classify(error))
            return false
        }
    }

    @discardableResult
    func setEnabled(_ subscription: MomoEventSubscription, enabled: Bool) async -> Bool {
        guard operation == .idle,
              subscription.workspaceId == workspaceID,
              subscription.enabled != enabled,
              let context,
              context.workspace == workspaceID
        else { return false }
        let currentGeneration = generation
        operation = .updating(subscription.id)
        mutationIssue = nil
        defer { if currentGeneration == generation { operation = .idle } }
        do {
            let updated = try await client.setEnabled(
                context: context,
                subscription: subscription.id,
                enabled: enabled
            )
            guard currentGeneration == generation, self.context == context else { return false }
            guard updated.id == subscription.id,
                  updated.workspaceId == workspaceID,
                  updated.enabled == enabled
            else { throw MomoEventSubscriptionClientError.invalidResponse }
            upsert(updated)
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard currentGeneration == generation, self.context == context else { return false }
            mutationIssue = .init(
                mutation: enabled ? .enable : .disable,
                failure: .classify(error)
            )
            return false
        }
    }

    @discardableResult
    func delete(_ subscription: MomoEventSubscription) async -> Bool {
        guard operation == .idle,
              subscription.workspaceId == workspaceID,
              let context,
              context.workspace == workspaceID
        else { return false }
        let currentGeneration = generation
        operation = .deleting(subscription.id)
        mutationIssue = nil
        defer { if currentGeneration == generation { operation = .idle } }
        do {
            let deleted = try await client.delete(context: context, subscription: subscription.id)
            guard currentGeneration == generation, self.context == context else { return false }
            guard deleted.id == subscription.id, deleted.workspaceId == workspaceID else {
                throw MomoEventSubscriptionClientError.invalidResponse
            }
            subscriptions.removeAll { $0.id == deleted.id }
            if oneTimeSecret?.eventSubscription.id == deleted.id { discardOneTimeSecret() }
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard currentGeneration == generation, self.context == context else { return false }
            mutationIssue = .init(mutation: .delete, failure: .classify(error))
            return false
        }
    }

    func copyOneTimeSecret() {
        guard let secret = oneTimeSecret?.secret, !secret.isEmpty else { return }
        copySecretValue(secret)
        copiedSecret = true
    }

    func discardOneTimeSecret() {
        oneTimeSecret = nil
        copiedSecret = false
    }

    func clearIssue() { mutationIssue = nil }

    static func normalizedURL(_ rawValue: String) -> String? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty,
              value.utf8.count <= 2_048,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              ["https", "http"].contains(scheme),
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.fragment == nil
        else { return nil }
        return value
    }

    private func upsert(_ subscription: MomoEventSubscription) {
        subscriptions.removeAll { $0.id == subscription.id }
        subscriptions.append(subscription)
        subscriptions = Self.sorted(subscriptions)
    }

    private static func sorted(_ values: [MomoEventSubscription]) -> [MomoEventSubscription] {
        values.sorted {
            if $0.createdAtMs == $1.createdAtMs {
                return $0.id.uuidString < $1.id.uuidString
            }
            return $0.createdAtMs > $1.createdAtMs
        }
    }
}
