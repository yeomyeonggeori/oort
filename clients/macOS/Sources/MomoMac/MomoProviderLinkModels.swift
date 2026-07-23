import Combine
import Foundation
import MomoCore

// MOMO-574 / ADR-0004 증보 1 (D1-D6): the admin "AI 연결" surface consumes the
// operator provider-link contract (docs/api/openapi.operator.yaml). momo stores
// only a Hermes-facing base URL + opaque bearer; the bearer is write-only and is
// never returned by the server (reads expose a boolean and a masked 4-char tail).

/// Which source won DB-over-env resolution for the effective provider link.
enum MomoProviderLinkSource: String, Codable, Sendable {
    case database
    case environment
}

/// Provider mode accepted by the operator surface. Deliberately mirrors the
/// three values in the operator contract; Core's `AgentProviderMode` also carries
/// a `gateway` case that the operator link never stores, so a local closed-world
/// enum keeps the PUT body and picker honest.
enum MomoProviderLinkMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case localMock = "local-mock"
    case internalHostMock = "internal-host-mock"
    case externalHermes = "external-hermes"

    var id: String { rawValue }
}

/// Redacted provider availability projection (never a token or secret URL).
enum MomoProviderLinkAvailability: String, Codable, Sendable {
    case mock
    case available
    case degraded
}

/// Effective provider link status returned by `GET/PUT/DELETE /v1/provider/link`.
/// The bearer never appears here: `bearerConfigured` and the masked `bearerLast4`
/// are the only signals.
struct MomoProviderLinkStatus: Decodable, Equatable, Sendable {
    let schema: String
    let configured: Bool
    let source: MomoProviderLinkSource
    let mode: MomoProviderLinkMode
    let baseUrl: String
    let endpointLabel: String
    let bearerConfigured: Bool
    let bearerLast4: String?
    let availability: MomoProviderLinkAvailability
    let keyConfigured: Bool
    let updatedAtMs: Int64?
    let updatedBy: UUID?
    let diagnostics: [String]
}

/// Coarse, credential-free probe result from `POST /v1/provider/link/test`.
struct MomoProviderLinkTestResult: Decodable, Equatable, Sendable {
    let schema: String
    let ok: Bool
    let reason: String?
    let source: MomoProviderLinkSource
    let mode: MomoProviderLinkMode
    let endpointLabel: String
    let checkedAtMs: Int64
}

/// Body for `PUT /v1/provider/link`. Closed-world on the server: only these
/// fields are accepted, so no Codex/OpenAI OAuth or raw-provider-key field can be
/// introduced (ADR-0004 Rules #1-#2). `bearer` is write-only.
struct MomoProviderLinkPutRequest: Encodable, Equatable, Sendable {
    let baseUrl: String
    let bearer: String
    let mode: MomoProviderLinkMode
}

protocol MomoProviderLinkClient: Sendable {
    func get(context: MomoInviteAdminContext) async throws -> MomoProviderLinkStatus
    func put(
        context: MomoInviteAdminContext,
        request: MomoProviderLinkPutRequest
    ) async throws -> MomoProviderLinkStatus
    func delete(context: MomoInviteAdminContext) async throws -> MomoProviderLinkStatus
    func test(context: MomoInviteAdminContext) async throws -> MomoProviderLinkTestResult
}

enum MomoProviderLinkClientError: Error, Equatable, LocalizedError, Sendable {
    case offline
    case invalidResponse
    case http(status: Int, message: String)
    case transport

    var errorDescription: String? {
        switch self {
        case .offline:
            return "The provider control plane is offline."
        case .invalidResponse:
            return "The server returned an unreadable provider response."
        case .http(_, let message):
            return message
        case .transport:
            return "The provider request could not reach the server."
        }
    }
}

enum MomoProviderLinkLoadState: Equatable {
    case idle
    case loading
    case loaded
    case unavailable
    case offline
    case failed(MomoProviderLinkUserFailure)
}

enum MomoProviderLinkOperation: Equatable {
    case idle
    case saving
    case testing
    case removing

    var isWorking: Bool { self != .idle }
}

enum MomoProviderLinkMutationAction: Equatable {
    case save
    case test
    case remove
}

struct MomoProviderLinkMutationIssue: Equatable {
    let action: MomoProviderLinkMutationAction
    let failure: MomoProviderLinkUserFailure
}

enum MomoProviderLinkNotice: Equatable {
    case saved
    case removed
}

enum MomoProviderLinkUserFailure: Equatable {
    case invalidInput
    case unauthorized
    case forbidden
    case conflict
    case invalidResponse
    case offline
    case other

    static func classify(_ error: Error) -> Self {
        if let providerError = error as? MomoProviderLinkClientError {
            switch providerError {
            case .offline, .transport:
                return .offline
            case .invalidResponse:
                return .invalidResponse
            case .http(let status, _):
                switch status {
                case 400: return .invalidInput
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

/// Lightweight client-side base URL guard so Save gives immediate feedback. The
/// server remains the authority (it rejects non-loopback http, userinfo, query,
/// and fragment); this only mirrors the shape so the button is not enabled for
/// obviously invalid input.
enum MomoProviderLinkBaseURL {
    static func isValid(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            return false
        }
        return true
    }
}

@MainActor
final class MomoProviderLinkSettingsModel: ObservableObject {
    @Published private(set) var loadState: MomoProviderLinkLoadState = .idle
    @Published private(set) var status: MomoProviderLinkStatus?
    @Published private(set) var operation: MomoProviderLinkOperation = .idle
    @Published private(set) var testResult: MomoProviderLinkTestResult?
    @Published private(set) var mutationIssue: MomoProviderLinkMutationIssue?
    @Published private(set) var notice: MomoProviderLinkNotice?

    @Published var baseURLDraft: String = ""
    /// Write-only: the entered bearer lives only in this field until Save, and is
    /// cleared afterwards. It is never populated from a server response.
    @Published var bearerDraft: String = ""
    @Published var modeDraft: MomoProviderLinkMode = .externalHermes

    private var context: MomoInviteAdminContext?
    private var contextGeneration: UInt64 = 0
    private let client: any MomoProviderLinkClient

    init(
        context: MomoInviteAdminContext?,
        client: any MomoProviderLinkClient
    ) {
        self.context = context
        self.client = client
    }

    var isWorking: Bool { operation.isWorking }

    /// True while there is unsaved secret input or an in-flight mutation, so the
    /// host can lock navigation the same way the webhook one-time secret does.
    var hasUnsavedBearer: Bool {
        !bearerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var navigationLocked: Bool { isWorking || hasUnsavedBearer }

    var canSave: Bool {
        !isWorking
            && MomoProviderLinkBaseURL.isValid(baseURLDraft)
            && !bearerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var canRemove: Bool {
        !isWorking && (status?.source == .database)
    }

    var canTest: Bool {
        // The reachability probe only means something against an external Hermes
        // target; mock/unconfigured modes always answer `not_external_provider`,
        // so the button stays disabled instead of guaranteeing a failing tap.
        !isWorking && loadState == .loaded && status?.mode == .externalHermes
    }

    func updateContext(_ newContext: MomoInviteAdminContext?) async {
        if context != newContext {
            contextGeneration &+= 1
            context = newContext
            status = nil
            operation = .idle
            testResult = nil
            mutationIssue = nil
            notice = nil
            baseURLDraft = ""
            bearerDraft = ""
            modeDraft = .externalHermes
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
        guard let context else {
            loadState = .unavailable
            return
        }

        let generation = contextGeneration
        loadState = .loading
        mutationIssue = nil
        do {
            let loaded = try await client.get(context: context)
            guard generation == contextGeneration, self.context == context else { return }
            apply(loaded, resetDrafts: true)
            loadState = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard generation == contextGeneration, self.context == context else { return }
            let failure = MomoProviderLinkUserFailure.classify(error)
            loadState = failure == .offline ? .offline : .failed(failure)
        }
    }

    @discardableResult
    func save() async -> Bool {
        guard operation == .idle, let context else { return false }
        let baseURL = baseURLDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let bearer = bearerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard MomoProviderLinkBaseURL.isValid(baseURL), !bearer.isEmpty else {
            mutationIssue = MomoProviderLinkMutationIssue(action: .save, failure: .invalidInput)
            return false
        }

        let generation = contextGeneration
        operation = .saving
        mutationIssue = nil
        notice = nil
        defer {
            if generation == contextGeneration { operation = .idle }
        }
        do {
            let updated = try await client.put(
                context: context,
                request: MomoProviderLinkPutRequest(
                    baseUrl: baseURL,
                    bearer: bearer,
                    mode: modeDraft
                )
            )
            guard generation == contextGeneration, self.context == context else { return false }
            apply(updated, resetDrafts: true)
            // The bearer never round-trips: drop it from memory once stored.
            bearerDraft = ""
            testResult = nil
            notice = .saved
            loadState = .loaded
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard generation == contextGeneration, self.context == context else { return false }
            mutationIssue = MomoProviderLinkMutationIssue(
                action: .save,
                failure: MomoProviderLinkUserFailure.classify(error)
            )
            return false
        }
    }

    @discardableResult
    func test() async -> Bool {
        guard operation == .idle, let context else { return false }

        let generation = contextGeneration
        operation = .testing
        mutationIssue = nil
        defer {
            if generation == contextGeneration { operation = .idle }
        }
        do {
            let result = try await client.test(context: context)
            guard generation == contextGeneration, self.context == context else { return false }
            testResult = result
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard generation == contextGeneration, self.context == context else { return false }
            testResult = nil
            mutationIssue = MomoProviderLinkMutationIssue(
                action: .test,
                failure: MomoProviderLinkUserFailure.classify(error)
            )
            return false
        }
    }

    @discardableResult
    func remove() async -> Bool {
        guard operation == .idle, let context, status?.source == .database else { return false }

        let generation = contextGeneration
        operation = .removing
        mutationIssue = nil
        notice = nil
        defer {
            if generation == contextGeneration { operation = .idle }
        }
        do {
            let updated = try await client.delete(context: context)
            guard generation == contextGeneration, self.context == context else { return false }
            apply(updated, resetDrafts: true)
            bearerDraft = ""
            testResult = nil
            notice = .removed
            loadState = .loaded
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard generation == contextGeneration, self.context == context else { return false }
            mutationIssue = MomoProviderLinkMutationIssue(
                action: .remove,
                failure: MomoProviderLinkUserFailure.classify(error)
            )
            return false
        }
    }

    /// Drop any unsaved secret input, e.g. when the surface disappears.
    func discardDraftSecret() {
        bearerDraft = ""
    }

    func clearFeedback() {
        mutationIssue = nil
        notice = nil
    }

    private func apply(_ newStatus: MomoProviderLinkStatus, resetDrafts: Bool) {
        status = newStatus
        if resetDrafts {
            baseURLDraft = newStatus.baseUrl
            // A stored (DB) link reflects its own mode; an env/unconfigured
            // instance defaults the picker to the common external-Hermes target.
            modeDraft = newStatus.source == .database ? newStatus.mode : .externalHermes
        }
    }
}
