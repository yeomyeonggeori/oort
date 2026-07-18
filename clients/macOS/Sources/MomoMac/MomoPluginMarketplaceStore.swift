import Foundation

@MainActor
final class MomoPluginMarketplaceStore: ObservableObject {
    enum Phase: Equatable {
        case idle
        case unavailable
        case loading
        case loaded
        case offline
        case failed(MomoPluginMarketplaceError)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var plugins: [MomoPluginCatalogEntry] = []
    @Published private(set) var grantedPluginIDs: Set<String> = []
    @Published private(set) var details: [String: MomoPluginDetail] = [:]
    @Published private(set) var detailFailures: [String: MomoPluginMarketplaceError] = [:]
    @Published private(set) var detailLoadingPluginIDs: Set<String> = []
    @Published private(set) var detailRevision = 0
    @Published private(set) var mutatingPluginIDs: Set<String> = []
    @Published private(set) var actionFailure: MomoPluginMarketplaceError?

    private let service: any MomoPluginMarketplaceService
    private var context: MomoInviteAdminContext?
    private var contextGeneration = 0

    init(
        service: any MomoPluginMarketplaceService = MomoPluginMarketplaceRESTService(),
        context: MomoInviteAdminContext?
    ) {
        self.service = service
        self.context = context
    }

    /// Rebinds every server-scoped value when the signed-in session changes.
    /// The generation guard prevents an old request from repopulating a new workspace.
    func updateContext(_ newContext: MomoInviteAdminContext?) async {
        if context == newContext, phase != .idle { return }

        contextGeneration += 1
        context = newContext
        resetServerScopedState()

        guard newContext != nil else {
            phase = .unavailable
            return
        }
        await refreshCatalog(showLoading: true, generation: contextGeneration)
    }

    func load() async {
        guard context != nil else {
            resetServerScopedState()
            phase = .unavailable
            return
        }
        await refreshCatalog(showLoading: true, generation: contextGeneration)
    }

    func retry() async {
        guard context != nil else {
            phase = .unavailable
            return
        }
        await refreshCatalog(showLoading: true, generation: contextGeneration)
    }

    func loadDetail(for plugin: MomoPluginCatalogEntry) async {
        guard !plugin.isChannelIntegration,
              details[plugin.id] == nil,
              !detailLoadingPluginIDs.contains(plugin.id),
              let context
        else { return }

        let generation = contextGeneration
        let revision = detailRevision
        detailLoadingPluginIDs.insert(plugin.id)
        defer {
            if isCurrent(context: context, generation: generation), detailRevision == revision {
                detailLoadingPluginIDs.remove(plugin.id)
            }
        }
        do {
            let detail = try await service.fetchDetail(pluginID: plugin.id, context: context)
            guard isCurrent(context: context, generation: generation), detailRevision == revision else {
                return
            }
            details[plugin.id] = detail
            detailFailures[plugin.id] = nil
        } catch is CancellationError {
            return
        } catch {
            guard isCurrent(context: context, generation: generation), detailRevision == revision else {
                return
            }
            detailFailures[plugin.id] = normalized(error)
        }
    }

    func install(_ plugin: MomoPluginCatalogEntry) async {
        guard !plugin.isChannelIntegration else {
            actionFailure = .channelIntegrationRequired
            return
        }
        guard let context else {
            actionFailure = .missingAuthentication
            return
        }
        let generation = contextGeneration
        await mutate(pluginID: plugin.id, context: context, generation: generation) {
            _ = try await service.install(pluginID: plugin.id, context: context)
        }
    }

    func revokeInstall(_ plugin: MomoPluginCatalogEntry) async {
        guard !plugin.isChannelIntegration else {
            actionFailure = .channelIntegrationRequired
            return
        }
        guard let context else {
            actionFailure = .missingAuthentication
            return
        }
        let generation = contextGeneration
        await mutate(pluginID: plugin.id, context: context, generation: generation) {
            _ = try await service.revokeInstall(pluginID: plugin.id, context: context)
        }
    }

    func toggleGrant(for plugin: MomoPluginCatalogEntry) async {
        guard !plugin.isChannelIntegration else {
            actionFailure = .channelIntegrationRequired
            return
        }
        guard let context else {
            actionFailure = .missingAuthentication
            return
        }

        let generation = contextGeneration
        await mutate(pluginID: plugin.id, context: context, generation: generation) {
            let detail = try await resolvedDetail(
                for: plugin,
                context: context,
                generation: generation
            )
            guard let scope = detail.singleDeclaredScope else {
                throw MomoPluginMarketplaceError.unsupportedScope(
                    pluginName: plugin.name,
                    declaredCount: detail.declaredScopes.count
                )
            }
            guard isCurrent(context: context, generation: generation) else {
                throw CancellationError()
            }
            if grantedPluginIDs.contains(plugin.id) {
                _ = try await service.revokeGrant(pluginID: plugin.id, scope: scope, context: context)
            } else {
                _ = try await service.grant(pluginID: plugin.id, scope: scope, context: context)
            }
        }
    }

    func dismissActionFailure() {
        actionFailure = nil
    }

    func isMutating(_ plugin: MomoPluginCatalogEntry) -> Bool {
        mutatingPluginIDs.contains(plugin.id)
    }

    private func mutate(
        pluginID: String,
        context: MomoInviteAdminContext,
        generation: Int,
        operation: () async throws -> Void
    ) async {
        guard isCurrent(context: context, generation: generation),
              !mutatingPluginIDs.contains(pluginID)
        else { return }

        mutatingPluginIDs.insert(pluginID)
        actionFailure = nil
        defer {
            if isCurrent(context: context, generation: generation) {
                mutatingPluginIDs.remove(pluginID)
            }
        }
        do {
            try await operation()
            guard isCurrent(context: context, generation: generation) else { return }
            await refreshCatalog(showLoading: false, generation: generation)
        } catch is CancellationError {
            return
        } catch {
            guard isCurrent(context: context, generation: generation) else { return }
            actionFailure = normalized(error)
        }
    }

    private func refreshCatalog(showLoading: Bool, generation: Int) async {
        guard let context else {
            phase = .unavailable
            return
        }
        guard isCurrent(context: context, generation: generation) else { return }
        if showLoading { phase = .loading }

        do {
            let snapshot = try await service.fetchCatalog(context: context)
            guard isCurrent(context: context, generation: generation) else { return }
            plugins = snapshot.plugins
            grantedPluginIDs = snapshot.grantedPluginIDs
            invalidateDetails()
            phase = .loaded
        } catch is CancellationError {
            return
        } catch {
            guard isCurrent(context: context, generation: generation) else { return }
            let failure = normalized(error)
            phase = failure.isOffline ? .offline : .failed(failure)
        }
    }

    private func resolvedDetail(
        for plugin: MomoPluginCatalogEntry,
        context: MomoInviteAdminContext,
        generation: Int
    ) async throws -> MomoPluginDetail {
        if let detail = details[plugin.id] { return detail }
        let revision = detailRevision
        let detail = try await service.fetchDetail(pluginID: plugin.id, context: context)
        guard isCurrent(context: context, generation: generation), detailRevision == revision else {
            throw CancellationError()
        }
        details[plugin.id] = detail
        detailFailures[plugin.id] = nil
        return detail
    }

    private func resetServerScopedState() {
        plugins = []
        grantedPluginIDs = []
        invalidateDetails()
        mutatingPluginIDs = []
        actionFailure = nil
    }

    private func invalidateDetails() {
        detailRevision += 1
        details = [:]
        detailFailures = [:]
        detailLoadingPluginIDs = []
    }

    private func isCurrent(context expectedContext: MomoInviteAdminContext, generation: Int) -> Bool {
        contextGeneration == generation && context == expectedContext
    }

    private func normalized(_ error: Error) -> MomoPluginMarketplaceError {
        if let error = error as? MomoPluginMarketplaceError { return error }
        if let error = error as? URLError {
            return .transport(code: error.code.rawValue, message: error.localizedDescription)
        }
        return .transport(code: URLError.unknown.rawValue, message: error.localizedDescription)
    }
}
