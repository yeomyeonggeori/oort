import Foundation
import MomoCore

// WH-2 (#706 / ADR-0114 증보 1): the admin "코드 실행 호스트" surface consumes the
// operator work-host-engine contract (MOMO-582):
//   GET  /v1/provider/work-host-engine -> effective engine + source
//   PUT  /v1/provider/work-host-engine  { engine } -> stored engine + source
// It selects which execution engine the instance runs (opencode default, goose, or
// codex-local). This is a separate path from the LLM provider link (MOMO-574, "AI
// 연결"): no credential is ever carried here, only a closed-world engine identifier.
//
// The load/operation/notice/failure vocabulary is deliberately reused from the
// provider-link surface so the two admin panes stay one coherent settings shell.

/// Execution engine selectable for the instance work host. Closed-world to mirror
/// the server contract; a raw string can never introduce a fourth engine client-side.
enum MomoWorkHostEngine: String, Codable, CaseIterable, Identifiable, Sendable {
    case opencode
    case goose
    case codexLocal = "codex-local"

    var id: String { rawValue }

    /// opencode and goose ship inside momo; codex-local reaches a CLI the operator
    /// installed on their own host.
    var isBundled: Bool { self != .codexLocal }
}

/// Which source won DB-over-default resolution for the effective engine.
enum MomoWorkHostEngineSource: String, Codable, Sendable {
    case database
    case `default`
}

/// Effective engine status returned by `GET/PUT /v1/provider/work-host-engine`.
/// `updatedBy` is kept as an opaque string (never rendered) so a member-id or UUID
/// shape from the server can never break decoding.
struct MomoWorkHostEngineStatus: Decodable, Equatable, Sendable {
    let engine: MomoWorkHostEngine
    let source: MomoWorkHostEngineSource
    let updatedBy: String?
    let updatedAtMs: Int64?
}

/// Body for `PUT /v1/provider/work-host-engine`. Closed-world on the server: only
/// the engine identifier is accepted.
struct MomoWorkHostEnginePutRequest: Encodable, Equatable, Sendable {
    let engine: MomoWorkHostEngine
}

protocol MomoWorkHostEngineClient: Sendable {
    func get(context: MomoInviteAdminContext) async throws -> MomoWorkHostEngineStatus
    func put(
        context: MomoInviteAdminContext,
        request: MomoWorkHostEnginePutRequest
    ) async throws -> MomoWorkHostEngineStatus
}

@MainActor
final class MomoWorkHostEngineSettingsModel: ObservableObject {
    @Published private(set) var loadState: MomoProviderLinkLoadState = .idle
    @Published private(set) var status: MomoWorkHostEngineStatus?
    @Published private(set) var operation: MomoProviderLinkOperation = .idle
    @Published private(set) var mutationIssue: MomoProviderLinkMutationIssue?
    @Published private(set) var notice: MomoProviderLinkNotice?

    /// The engine the operator has selected but not yet saved. Seeded from the
    /// effective status on load and reset to the stored engine after a save.
    @Published var engineDraft: MomoWorkHostEngine = .opencode

    private var context: MomoInviteAdminContext?
    private var contextGeneration: UInt64 = 0
    private let client: any MomoWorkHostEngineClient

    init(
        context: MomoInviteAdminContext?,
        client: any MomoWorkHostEngineClient
    ) {
        self.context = context
        self.client = client
    }

    var isWorking: Bool { operation.isWorking }

    /// Save is enabled only when the picker moved off the stored engine, so an
    /// idempotent PUT is never sent and the button is honest about having work.
    var canSave: Bool {
        guard !isWorking, loadState == .loaded, let status else { return false }
        return engineDraft != status.engine
    }

    func updateContext(_ newContext: MomoInviteAdminContext?) async {
        if context != newContext {
            contextGeneration &+= 1
            context = newContext
            status = nil
            operation = .idle
            mutationIssue = nil
            notice = nil
            engineDraft = .opencode
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
            apply(loaded)
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
        guard operation == .idle, let context, let status, engineDraft != status.engine else {
            return false
        }

        let generation = contextGeneration
        let requested = engineDraft
        operation = .saving
        mutationIssue = nil
        notice = nil
        defer {
            if generation == contextGeneration { operation = .idle }
        }
        do {
            let updated = try await client.put(
                context: context,
                request: MomoWorkHostEnginePutRequest(engine: requested)
            )
            guard generation == contextGeneration, self.context == context else { return false }
            apply(updated)
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

    func clearFeedback() {
        mutationIssue = nil
        notice = nil
    }

    private func apply(_ newStatus: MomoWorkHostEngineStatus) {
        status = newStatus
        engineDraft = newStatus.engine
    }
}
