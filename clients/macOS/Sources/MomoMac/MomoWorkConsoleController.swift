import Foundation
import MomoACPHost
import MomoCore

enum MomoWorkSessionShortcut {
    static func index(number: Int, sessionCount: Int) -> Int? {
        guard (1...9).contains(number), number <= sessionCount else { return nil }
        return number - 1
    }
}

struct MomoPendingWorkRead: Identifiable, Equatable {
    var id: WorkControlID { controlId }
    let controlId: WorkControlID
    let sessionId: WorkSessionID
    let requesterMemberId: MemberID
    let lineCount: Int
}

@MainActor
final class MomoWorkConsoleController: ObservableObject {
    @Published private(set) var sessions: [MomoWorkSession] = []
    @Published var selectedSessionId: WorkSessionID?
    @Published private(set) var localSessions: [WorkSessionID: MomoLocalTerminalSession] = [:]
    @Published private(set) var acpSessions: [WorkSessionID: MomoLocalACPSession] = [:]
    @Published private(set) var remoteSessions: [WorkSessionID: MomoRemoteTerminalSession] = [:]
    @Published private(set) var workHosts: [WorkHostID: WorkHost] = [:]
    @Published private(set) var pendingReads: [WorkSessionID: MomoPendingWorkRead] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isStarting = false
    @Published private(set) var lastIssue: MomoWorkConsoleError?
    @Published private(set) var autoApproveStates: [MomoWorkTool: MomoWorkAutoApproveState] = [:]
    @Published private(set) var hostRegistrationState: MomoWorkHostRegistrationState = .waitingForSession
    @Published private(set) var hostHeartbeatIssue: MomoWorkConsoleError?
    @Published private(set) var observationUpdatesInFlight: Set<WorkSessionID> = []
    @Published private(set) var tierPolicies: [MomoWorkTierPolicyScope: MomoWorkTierPolicy] = [:]
    @Published private(set) var tierPolicyUpdatesInFlight: Set<MomoWorkTierPolicyScope> = []
    @Published private(set) var tierPolicyLoadFailed = false
    @Published private(set) var resumeUpdatesInFlight: Set<WorkSessionID> = []
    @Published private(set) var toolProfiles: [MomoWorkToolProfile] = []
    @Published private(set) var toolProfileIssue: MomoWorkConsoleError?
    @Published private(set) var isLoadingToolProfiles = false
    @Published private(set) var mutatingToolKeys: Set<String> = []

    private let viewModel: ChatViewModel
    private let workHostRegistrar: MomoWorkHostRegistrar
    private let remoteTransportFactory: @MainActor () -> any MomoRemoteTerminalTransport
    private var workspaceId: WorkspaceID?
    private var memberId: MemberID?
    private var handledControlIds: Set<WorkControlID> = []
    private var endingSessionIds: Set<WorkSessionID> = []
    private var heartbeatTask: Task<Void, Never>?

    init(
        viewModel: ChatViewModel,
        workHostRegistrar: MomoWorkHostRegistrar = MomoWorkHostRegistrar(),
        remoteTransportFactory: @escaping @MainActor () -> any MomoRemoteTerminalTransport = {
            MomoURLSessionRemoteTerminalTransport()
        },
        initialHostRegistrationState: MomoWorkHostRegistrationState = .waitingForSession,
        initialToolProfiles: [MomoWorkToolProfile] = []
    ) {
        self.viewModel = viewModel
        self.workHostRegistrar = workHostRegistrar
        self.remoteTransportFactory = remoteTransportFactory
        self.hostRegistrationState = initialHostRegistrationState
        toolProfiles = initialToolProfiles
    }

    var supportsWorkConsole: Bool { viewModel.supportsWorkConsole }

    var hostId: WorkHostID? { hostRegistrationState.host?.id }

    var isHostReady: Bool { hostRegistrationState.host != nil }

    var canManageWorkspaceTierPolicy: Bool { viewModel.canManageWorkspace }

    var canManageToolProfiles: Bool { viewModel.canManageWorkspace }

    var enabledToolProfiles: [MomoWorkToolProfile] {
        toolProfiles.filter(\.enabled)
    }

    func profile(for tool: MomoWorkTool) -> MomoWorkToolProfile? {
        toolProfiles.first { $0.tool == tool && $0.enabled }
    }

    var selectedSession: MomoWorkSession? {
        guard let selectedSessionId else { return nil }
        return sessions.first { $0.id == selectedSessionId }
    }

    var selectedLocalSession: MomoLocalTerminalSession? {
        selectedSessionId.flatMap { localSessions[$0] }
    }

    var selectedRemoteSession: MomoRemoteTerminalSession? {
        selectedSessionId.flatMap { remoteSessions[$0] }
    }

    func owns(_ session: MomoWorkSession) -> Bool {
        session.memberId == viewModel.currentNavigationMemberID
    }

    func activate(workspace nextWorkspace: WorkspaceID?, member nextMember: MemberID?) async {
        if workspaceId != nextWorkspace || memberId != nextMember {
            heartbeatTask?.cancel()
            heartbeatTask = nil
            localSessions.values.forEach { $0.terminate() }
            acpSessions.values.forEach { $0.terminate() }
            remoteSessions.values.forEach { $0.disconnect() }
            localSessions = [:]
            acpSessions = [:]
            remoteSessions = [:]
            workHosts = [:]
            pendingReads = [:]
            handledControlIds = []
            sessions = []
            selectedSessionId = nil
            workspaceId = nextWorkspace
            memberId = nextMember
            hostRegistrationState = .waitingForSession
            hostHeartbeatIssue = nil
            tierPolicies = [:]
            tierPolicyUpdatesInFlight = []
            tierPolicyLoadFailed = false
            resumeUpdatesInFlight = []
            toolProfiles = []
            toolProfileIssue = nil
            mutatingToolKeys = []
        }
        guard let nextWorkspace, let nextMember else {
            if nextWorkspace == nil { lastIssue = .noWorkspace }
            return
        }
        await reconcileWorkHost(workspace: nextWorkspace, member: nextMember)
        await refreshToolProfiles()
        await refresh()
    }

    func retryWorkHostRegistration() async {
        guard let workspaceId, let memberId else { return }
        await reconcileWorkHost(workspace: workspaceId, member: memberId)
    }

    func refreshToolProfiles() async {
        guard supportsWorkConsole else {
            toolProfiles = []
            toolProfileIssue = .unavailable
            return
        }
        isLoadingToolProfiles = true
        defer { isLoadingToolProfiles = false }
        do {
            let profiles: [MomoWorkToolProfile]
            if canManageToolProfiles {
                profiles = try await viewModel.loadWorkToolProfiles()
            } else {
                guard let workspaceId,
                      let hostId,
                      let backend = try? viewModel.workHostBackendForCurrentSession()
                else { throw MomoWorkConsoleError.toolProfileUnavailable }
                profiles = try await workHostRegistrar.enabledToolProfiles(
                    workspace: workspaceId,
                    host: hostId,
                    sentAtMs: Int64(Date().timeIntervalSince1970 * 1_000),
                    backend: backend
                )
            }
            toolProfiles = profiles.sorted { ($0.displayName, $0.toolKey) < ($1.displayName, $1.toolKey) }
            autoApproveStates = Dictionary(
                uniqueKeysWithValues: profiles.map { ($0.tool, autoApproveStates[$0.tool] ?? .unknown) }
            )
            toolProfileIssue = nil
        } catch is CancellationError {
            return
        } catch {
            toolProfiles = []
            autoApproveStates = [:]
            toolProfileIssue = .toolProfileUnavailable
        }
    }

    func saveToolProfile(
        _ draft: MomoWorkToolProfileDraft,
        replacing profile: MomoWorkToolProfile?
    ) async -> Bool {
        guard canManageToolProfiles else { return false }
        let normalizedKey = draft.toolKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalizedKey.isEmpty, !mutatingToolKeys.contains(normalizedKey) else { return false }
        mutatingToolKeys.insert(normalizedKey)
        defer { mutatingToolKeys.remove(normalizedKey) }
        do {
            let saved: MomoWorkToolProfile
            if let profile {
                saved = try await viewModel.updateWorkToolProfile(tool: profile.tool, draft: draft)
            } else {
                saved = try await viewModel.createWorkToolProfile(draft)
            }
            upsertToolProfile(saved)
            toolProfileIssue = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            toolProfileIssue = .toolProfileUnavailable
            return false
        }
    }

    func deleteToolProfile(_ profile: MomoWorkToolProfile) async -> Bool {
        guard canManageToolProfiles, !mutatingToolKeys.contains(profile.toolKey) else { return false }
        mutatingToolKeys.insert(profile.toolKey)
        defer { mutatingToolKeys.remove(profile.toolKey) }
        do {
            _ = try await viewModel.deleteWorkToolProfile(tool: profile.tool)
            toolProfiles.removeAll { $0.id == profile.id }
            autoApproveStates[profile.tool] = nil
            toolProfileIssue = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            toolProfileIssue = .toolProfileUnavailable
            return false
        }
    }

    func refresh() async {
        guard supportsWorkConsole else {
            lastIssue = .unavailable
            return
        }
        guard workspaceId != nil else {
            lastIssue = .noWorkspace
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            sessions = try await viewModel.loadWorkSessions(activeOnly: false)
                .sorted(by: Self.sessionOrder)
            for session in sessions where !session.isRunning {
                remoteSessions[session.id]?.markEnded()
            }
            reconcileObserverAccess()
            await refreshWorkHosts()
            await refreshTierPolicies()
            if let selectedSessionId,
               !sessions.contains(where: { $0.id == selectedSessionId }) {
                self.selectedSessionId = sessions.first?.id
            } else if selectedSessionId == nil {
                selectedSessionId = sessions.first(where: \.isRunning)?.id ?? sessions.first?.id
            }
            lastIssue = nil
        } catch is CancellationError {
            return
        } catch {
            lastIssue = .unavailable
        }
    }

    func startSession(
        tool: MomoWorkTool,
        label rawLabel: String,
        directory: URL?,
        initialPrompt: String? = nil
    ) async -> Bool {
        guard !isStarting else { return false }
        guard isHostReady else {
            lastIssue = .hostRegistrationFailed
            return false
        }
        guard let channel = viewModel.selectedChannelId else {
            lastIssue = .noChannel
            return false
        }
        let label = Self.normalizedLabel(rawLabel, tool: tool, directory: directory)
        isStarting = true
        defer { isStarting = false }
        do {
            guard let profile = profile(for: tool) else {
                throw MomoWorkConsoleError.toolProfileUnavailable
            }
            let session = try await createAndLaunch(
                channel: channel,
                profile: profile,
                label: label,
                directory: directory,
                initialPrompt: initialPrompt
            )
            upsert(session)
            selectedSessionId = session.id
            lastIssue = nil
            return true
        } catch let issue as MomoWorkConsoleError {
            lastIssue = issue
            return false
        } catch is CancellationError {
            return false
        } catch {
            lastIssue = .localLaunchFailed
            return false
        }
    }

    func startDefaultShell() async -> Bool {
        let started = await startSession(
            tool: .shell,
            label: Self.automaticTerminalLabel(existingLabels: sessions.map(\.label)),
            directory: nil
        )
        if started, let selectedSessionId {
            focusSession(selectedSessionId)
        }
        return started
    }

    @discardableResult
    func selectSession(shortcutNumber: Int) -> Bool {
        guard let index = MomoWorkSessionShortcut.index(
            number: shortcutNumber,
            sessionCount: sessions.count
        ) else { return false }
        let session = sessions[index]
        selectedSessionId = session.id
        focusSession(session.id)
        return true
    }

    func endSession(_ session: MomoWorkSession) async {
        guard !endingSessionIds.contains(session.id) else { return }
        endingSessionIds.insert(session.id)
        defer { endingSessionIds.remove(session.id) }
        localSessions[session.id]?.terminate()
        remoteSessions[session.id]?.terminate()
        do {
            upsert(try await viewModel.endWorkSession(session.id, exitCode: nil))
            lastIssue = nil
        } catch is CancellationError {
            return
        } catch {
            lastIssue = .sessionUnavailable
        }
    }

    func consume(_ event: MomoWorkConsoleRealtimeEvent) async {
        switch event.payload {
        case .session(let delta):
            apply(delta)
            // Lifecycle deltas intentionally stay minimal. Refresh the REST
            // projection so orphan/end reasons and resume lineage remain
            // authoritative without widening the realtime Core contract.
            await refresh()
        case .control(let delta):
            guard let hostId else { return }
            guard delta.action == .dispatched,
                  delta.targetHostId == hostId,
                  !handledControlIds.contains(delta.controlId)
            else { return }
            handledControlIds.insert(delta.controlId)
            await execute(delta)
        case .projectionRefresh(let sessionID):
            await refresh()
            if sessions.contains(where: { $0.id == sessionID }) {
                selectedSessionId = sessionID
            }
        }
    }

    func previewExcerpt(lineCount: Int = 80) -> String {
        selectedLocalSession?.tail(lineCount: lineCount) ?? ""
    }

    func shareExcerpt(_ text: String, for session: MomoWorkSession) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            lastIssue = .excerptEmpty
            return false
        }
        let didSend = await viewModel.shareWorkExcerpt(trimmed, session: session)
        lastIssue = didSend ? nil : .excerptSendFailed
        return didSend
    }

    func sharePendingRead(_ request: MomoPendingWorkRead, excerpt: String) async -> Bool {
        guard let session = sessions.first(where: { $0.id == request.sessionId }) else {
            lastIssue = .sessionUnavailable
            return false
        }
        let trimmed = excerpt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            lastIssue = .excerptEmpty
            return false
        }
        let didSend = await viewModel.shareWorkExcerpt(
            trimmed,
            session: session,
            requestingMember: request.requesterMemberId
        )
        guard didSend else {
            lastIssue = .excerptSendFailed
            return false
        }
        do {
            try await viewModel.acknowledgeWorkControl(
                request.controlId,
                ok: true,
                session: request.sessionId,
                errorLabel: nil
            )
            pendingReads[request.sessionId] = nil
            lastIssue = nil
            return true
        } catch {
            lastIssue = .sessionUnavailable
            return false
        }
    }

    func declinePendingRead(_ request: MomoPendingWorkRead) async {
        do {
            try await viewModel.acknowledgeWorkControl(
                request.controlId,
                ok: false,
                session: request.sessionId,
                errorLabel: "User declined output sharing"
            )
            pendingReads[request.sessionId] = nil
        } catch {
            lastIssue = .sessionUnavailable
        }
    }

    func setAutoApprove(_ enabled: Bool, for tool: MomoWorkTool) async {
        guard autoApproveStates[tool] != .updating else { return }
        autoApproveStates[tool] = .updating
        do {
            let serverValue = try await viewModel.setWorkAutoApprove(
                tool: tool,
                enabled: enabled
            )
            autoApproveStates[tool] = serverValue ? .enabled : .disabled
            lastIssue = nil
        } catch is CancellationError {
            autoApproveStates[tool] = .unknown
        } catch {
            autoApproveStates[tool] = .failed
            lastIssue = .unavailable
        }
    }

    func openThread(_ session: MomoWorkSession) async {
        await viewModel.requestWorkSessionThread(session)
    }

    func selectSession(_ sessionID: WorkSessionID) async {
        if !sessions.contains(where: { $0.id == sessionID }) {
            await refresh()
        }
        if sessions.contains(where: { $0.id == sessionID }) {
            selectedSessionId = sessionID
        }
    }

    func resumeTargets(for session: MomoWorkSession) -> [WorkHost] {
        workHosts.values
            .filter {
                !$0.isRevoked
                    && $0.online
                    && $0.id != session.hostId
                    && ($0.scope == .workspace || $0.ownerMemberId == memberId)
            }
            .sorted {
                let nameOrder = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
                return nameOrder == .orderedSame
                    ? $0.id.description.lowercased() < $1.id.description.lowercased()
                    : nameOrder == .orderedAscending
            }
    }

    func resume(_ session: MomoWorkSession, on targetHost: WorkHostID) async -> Bool {
        guard owns(session), session.isOrphaned,
              !resumeUpdatesInFlight.contains(session.id),
              resumeTargets(for: session).contains(where: { $0.id == targetHost })
        else { return false }
        resumeUpdatesInFlight.insert(session.id)
        defer { resumeUpdatesInFlight.remove(session.id) }
        do {
            let resumed = try await viewModel.resumeWorkSession(
                session.id,
                targetHost: targetHost
            )
            await refresh()
            upsert(resumed)
            selectedSessionId = resumed.id
            lastIssue = nil
            return true
        } catch is CancellationError {
            return false
        } catch {
            lastIssue = .sessionUnavailable
            return false
        }
    }

    func setTierPolicy(
        scope: MomoWorkTierPolicyScope,
        mode: MomoWorkTierPolicyMode,
        autoTarget: String? = nil
    ) async {
        guard !tierPolicyUpdatesInFlight.contains(scope),
              scope == .member || canManageWorkspaceTierPolicy else { return }
        tierPolicyUpdatesInFlight.insert(scope)
        defer { tierPolicyUpdatesInFlight.remove(scope) }
        do {
            tierPolicies[scope] = try await viewModel.setWorkTierPolicy(
                scope: scope,
                mode: mode,
                autoTarget: autoTarget
            )
            tierPolicyLoadFailed = false
            lastIssue = nil
        } catch is CancellationError {
            return
        } catch {
            tierPolicyLoadFailed = true
            lastIssue = .unavailable
        }
    }

    func canOpenRemoteTerminal(_ session: MomoWorkSession) -> Bool {
        terminalAttachMode(for: session) != nil
    }

    func canOpenRemoteTerminal(sessionId: WorkSessionID) -> Bool {
        sessions.first(where: { $0.id == sessionId }).map(canOpenRemoteTerminal) ?? false
    }

    func hostDisplayName(for session: MomoWorkSession) -> String? {
        workHosts[session.hostId]?.displayName
    }

    func terminalAttachMode(for session: MomoWorkSession) -> MomoTerminalAttachMode? {
        MomoTerminalAttachPolicy.mode(
            for: session,
            currentMemberID: viewModel.currentNavigationMemberID,
            hasLocalTerminal: localSessions[session.id] != nil
        )
    }

    func setObservation(
        _ observation: MomoWorkSessionObservation,
        for session: MomoWorkSession
    ) async {
        guard owns(session), !observationUpdatesInFlight.contains(session.id) else { return }
        observationUpdatesInFlight.insert(session.id)
        defer { observationUpdatesInFlight.remove(session.id) }
        do {
            upsert(try await viewModel.setWorkSessionObservation(
                session.id,
                observation: observation
            ))
            lastIssue = nil
        } catch is CancellationError {
            return
        } catch {
            lastIssue = .sessionUnavailable
        }
    }

    func openRemoteTerminal(_ session: MomoWorkSession) async {
        guard let mode = terminalAttachMode(for: session) else { return }
        if let existing = remoteSessions[session.id] {
            guard existing.mode == mode else {
                existing.disconnect()
                remoteSessions[session.id] = nil
                return await openRemoteTerminal(session)
            }
            await existing.retry()
            return
        }
        let remote = MomoRemoteTerminalSession(
            mode: mode,
            grantProvider: { [weak viewModel] in
                guard let viewModel else { throw MomoWorkConsoleError.unavailable }
                return try await viewModel.issueTerminalAttach(session.id, mode: mode)
            },
            transport: remoteTransportFactory()
        )
        remoteSessions[session.id] = remote
        selectedSessionId = session.id
        await remote.start()
        if mode == .observer, remote.isConnected {
            await refresh()
        }
    }

    func openRemoteTerminal(sessionId: WorkSessionID) async {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        await openRemoteTerminal(session)
    }

    func disconnectRemoteTerminals() {
        remoteSessions.values.forEach { $0.disconnect() }
        remoteSessions = [:]
    }

    func shutdown() async {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        let running = sessions.filter { $0.isRunning && localSessions[$0.id] != nil }
        let runningIDs = Set(running.map(\.id))
        endingSessionIds.formUnion(runningIDs)
        defer { endingSessionIds.subtract(runningIDs) }
        localSessions.values.forEach { $0.terminate() }
        acpSessions.values.forEach { $0.terminate() }
        remoteSessions.values.forEach { $0.disconnect() }
        for session in running {
            _ = try? await viewModel.endWorkSession(session.id, exitCode: nil)
        }
        localSessions = [:]
        acpSessions = [:]
        remoteSessions = [:]
        pendingReads = [:]
    }

    private func createAndLaunch(
        channel: ChannelID,
        profile: MomoWorkToolProfile,
        label: String,
        directory: URL?,
        initialPrompt: String?
    ) async throws -> MomoWorkSession {
        guard let hostId else { throw MomoWorkConsoleError.hostRegistrationFailed }
        let session = try await viewModel.createWorkSession(
            channel: channel,
            host: hostId,
            tool: profile.tool,
            label: label
        )
        do {
            switch profile.transport {
            case .pty:
                let local = MomoLocalTerminalSession { [weak self] exitCode in
                    guard let self else { return }
                    Task { await self.localProcessEnded(session.id, exitCode: exitCode) }
                }
                try local.start(profile: profile, directory: directory)
                localSessions[session.id] = local
            case .acp:
                let spec = try MomoWorkLaunchSpec.resolve(profile: profile)
                let proposedPrompt = initialPrompt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let environment: [String: String] = Dictionary(
                    uniqueKeysWithValues: spec.environment.compactMap { entry -> (String, String)? in
                    guard let divider = entry.firstIndex(of: "=") else { return nil }
                    return (String(entry[..<divider]), String(entry[entry.index(after: divider)...]))
                    }
                )
                let acp = MomoLocalACPSession { [weak self] exitCode in
                    guard let self else { return }
                    Task { await self.localProcessEnded(session.id, exitCode: exitCode) }
                }
                acp.start(
                    command: ACPLaunchCommand(
                        executable: spec.executable,
                        arguments: spec.arguments,
                        workingDirectory: directory ?? FileManager.default.homeDirectoryForCurrentUser,
                        environment: environment
                    ),
                    context: ACPHostContext(
                        workSessionID: session.id.rawValue,
                        channelID: channel.rawValue,
                        agentMemberID: nil
                    ),
                    prompt: proposedPrompt.isEmpty ? label : proposedPrompt,
                    terminalHandler: LocalPTYTerminalManager(
                        defaultWorkingDirectory: directory ?? FileManager.default.homeDirectoryForCurrentUser,
                        baseEnvironment: environment
                    )
                )
                acpSessions[session.id] = acp
            }
        } catch {
            _ = try? await viewModel.endWorkSession(session.id, exitCode: nil)
            throw error
        }
        return session
    }

    private func execute(_ control: WorkControlDelta) async {
        do {
            switch control.kind {
            case .spawn:
                try await executeSpawn(control)
            case .input:
                try await executeInput(control)
            case .read:
                try await stageRead(control)
            case .kill:
                try await executeKill(control)
            }
        } catch let issue as MomoWorkConsoleError {
            lastIssue = issue
            await acknowledgeFailure(control, issue: issue)
        } catch {
            lastIssue = .sessionUnavailable
            await acknowledgeFailure(control, issue: .sessionUnavailable)
        }
    }

    private func executeSpawn(_ control: WorkControlDelta) async throws {
        guard let rawTool = control.payload["tool"]?.stringValue,
              let rawLabel = control.payload["label"]?.stringValue
        else { throw MomoWorkConsoleError.localLaunchFailed }
        let tool = MomoWorkTool(rawValue: rawTool)
        guard let profile = profile(for: tool) else {
            throw MomoWorkConsoleError.toolProfileUnavailable
        }
        let session = try await createAndLaunch(
            channel: control.channelId,
            profile: profile,
            label: Self.normalizedLabel(rawLabel, tool: tool, directory: nil),
            directory: nil,
            initialPrompt: rawLabel
        )
        do {
            try await viewModel.acknowledgeWorkControl(
                control.controlId,
                ok: true,
                session: session.id,
                errorLabel: nil
            )
        } catch {
            localSessions[session.id]?.terminate()
            _ = try? await viewModel.endWorkSession(session.id, exitCode: nil)
            throw error
        }
        upsert(session)
        selectedSessionId = session.id
        lastIssue = nil
    }

    private func executeInput(_ control: WorkControlDelta) async throws {
        guard let sessionId = control.sessionId,
              let text = control.payload["text"]?.stringValue,
              !text.isEmpty
        else { throw MomoWorkConsoleError.sessionUnavailable }
        if let local = localSessions[sessionId], local.isRunning {
            local.sendInput(text)
        } else if let acp = acpSessions[sessionId], acp.isRunning {
            acp.sendPrompt(text)
        } else {
            throw MomoWorkConsoleError.sessionUnavailable
        }
        try await viewModel.acknowledgeWorkControl(
            control.controlId,
            ok: true,
            session: sessionId,
            errorLabel: nil
        )
    }

    private func stageRead(_ control: WorkControlDelta) async throws {
        guard let sessionId = control.sessionId,
              localSessions[sessionId]?.isRunning == true
        else { throw MomoWorkConsoleError.sessionUnavailable }
        let requested = Int(control.payload["tail_lines"]?.intValue ?? 80)
        pendingReads[sessionId] = MomoPendingWorkRead(
            controlId: control.controlId,
            sessionId: sessionId,
            requesterMemberId: control.requesterMemberId,
            lineCount: max(1, min(requested, 9_999))
        )
        selectedSessionId = sessionId
    }

    private func executeKill(_ control: WorkControlDelta) async throws {
        guard let sessionId = control.sessionId,
              let session = sessions.first(where: { $0.id == sessionId }),
              localSessions[sessionId] != nil || acpSessions[sessionId] != nil
        else { throw MomoWorkConsoleError.sessionUnavailable }
        guard !endingSessionIds.contains(sessionId) else {
            throw MomoWorkConsoleError.sessionUnavailable
        }
        endingSessionIds.insert(sessionId)
        defer { endingSessionIds.remove(sessionId) }
        localSessions[sessionId]?.terminate()
        acpSessions[sessionId]?.terminate()
        upsert(try await viewModel.endWorkSession(sessionId, exitCode: nil))
        try await viewModel.acknowledgeWorkControl(
            control.controlId,
            ok: true,
            session: session.id,
            errorLabel: nil
        )
    }

    private func acknowledgeFailure(
        _ control: WorkControlDelta,
        issue: MomoWorkConsoleError
    ) async {
        let label: String
        switch issue {
        case .executableUnavailable(let tool): label = "Executable unavailable: \(tool.rawValue)"
        case .sandboxRestricted: label = "Host app sandbox blocks local process"
        case .localLaunchFailed: label = "Local process launch failed"
        case .sessionUnavailable: label = "Local session unavailable"
        default: label = "Work host unavailable"
        }
        try? await viewModel.acknowledgeWorkControl(
            control.controlId,
            ok: false,
            session: control.sessionId,
            errorLabel: label
        )
    }

    private func localProcessEnded(_ sessionId: WorkSessionID, exitCode: Int?) async {
        guard !endingSessionIds.contains(sessionId),
              sessions.first(where: { $0.id == sessionId })?.isRunning == true
        else { return }
        endingSessionIds.insert(sessionId)
        defer { endingSessionIds.remove(sessionId) }
        do {
            upsert(try await viewModel.endWorkSession(sessionId, exitCode: exitCode))
        } catch {
            lastIssue = .sessionUnavailable
        }
    }

    private func apply(_ delta: WorkSessionDelta) {
        if let index = sessions.firstIndex(where: { $0.id == delta.sessionId }) {
            sessions[index].apply(delta)
            if delta.action == .ended {
                remoteSessions[delta.sessionId]?.markEnded()
            }
            sessions.sort(by: Self.sessionOrder)
            return
        }
        guard let workspaceId else { return }
        let session = MomoWorkSession(
            id: delta.sessionId,
            workspaceId: workspaceId,
            channelId: delta.channelId,
            memberId: delta.memberId,
            hostId: delta.hostId,
            rootMessageId: delta.rootMessageId,
            tool: MomoWorkTool(delta.tool),
            label: delta.label,
            status: delta.action == .started ? .running : .ended,
            startedAtMs: delta.startedAtMs ?? 0,
            endedAtMs: delta.endedAtMs,
            exitCode: delta.exitCode
        )
        upsert(session)
    }

    private func upsert(_ session: MomoWorkSession) {
        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[index] = session
        } else {
            sessions.append(session)
        }
        sessions.sort(by: Self.sessionOrder)
        if !session.isRunning {
            remoteSessions[session.id]?.markEnded()
        } else if session.observation != .open,
                  remoteSessions[session.id]?.mode == .observer {
            remoteSessions[session.id]?.disconnect()
            remoteSessions[session.id] = nil
        }
    }

    private func upsertToolProfile(_ profile: MomoWorkToolProfile) {
        if let index = toolProfiles.firstIndex(where: { $0.id == profile.id }) {
            toolProfiles[index] = profile
        } else {
            toolProfiles.append(profile)
        }
        toolProfiles.sort { ($0.displayName, $0.toolKey) < ($1.displayName, $1.toolKey) }
        autoApproveStates[profile.tool] = autoApproveStates[profile.tool] ?? .unknown
    }

    private func reconcileObserverAccess() {
        let unavailableObserverIDs: [WorkSessionID] = remoteSessions.compactMap { entry in
            let (sessionID, remote) = entry
            guard remote.mode == .observer else { return nil }
            guard let session = sessions.first(where: { $0.id == sessionID }),
                  terminalAttachMode(for: session) == .observer else { return sessionID }
            return nil
        }
        for sessionID in unavailableObserverIDs {
            remoteSessions[sessionID]?.disconnect()
            remoteSessions[sessionID] = nil
        }
    }

    private func refreshWorkHosts() async {
        guard let backend = try? viewModel.workHostBackendForCurrentSession(),
              let workspaceId,
              let hosts = try? await backend.workHosts(workspace: workspaceId)
        else { return }
        workHosts = Dictionary(uniqueKeysWithValues: hosts.map { ($0.id, $0) })
    }

    private func refreshTierPolicies() async {
        do {
            tierPolicies[.member] = try await viewModel.workTierPolicy(scope: .member)
            if canManageWorkspaceTierPolicy {
                tierPolicies[.workspace] = try await viewModel.workTierPolicy(scope: .workspace)
            } else {
                tierPolicies[.workspace] = nil
            }
            tierPolicyLoadFailed = false
        } catch is CancellationError {
            return
        } catch {
            tierPolicyLoadFailed = true
        }
    }

    private static func normalizedLabel(
        _ raw: String,
        tool: MomoWorkTool,
        directory: URL?
    ) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return String(trimmed.prefix(120)) }
        if let directory {
            let name = directory.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty { return String(name.prefix(120)) }
        }
        return tool.rawValue
    }

    static func automaticTerminalLabel(existingLabels: [String]) -> String {
        let normalized = Set(existingLabels.map { $0.lowercased() })
        for number in 1...9_999 {
            let candidate = "Terminal \(number)"
            if !normalized.contains(candidate.lowercased()) { return candidate }
        }
        return "Terminal"
    }

    private func focusSession(_ sessionId: WorkSessionID) {
        Task { @MainActor [weak self] in
            await Task.yield()
            self?.localSessions[sessionId]?.focus()
        }
    }

    private static func sessionOrder(_ lhs: MomoWorkSession, _ rhs: MomoWorkSession) -> Bool {
        if lhs.isRunning != rhs.isRunning { return lhs.isRunning }
        return (lhs.startedAtMs, lhs.id.description) > (rhs.startedAtMs, rhs.id.description)
    }

    private func reconcileWorkHost(
        workspace: WorkspaceID,
        member: MemberID,
        heartbeatImmediately: Bool = true
    ) async {
        guard supportsWorkConsole else {
            hostRegistrationState = .failed(.unavailable)
            return
        }
        hostRegistrationState = .registering
        hostHeartbeatIssue = nil
        do {
            let backend = try viewModel.workHostBackendForCurrentSession()
            let host = try await workHostRegistrar.reconcile(
                workspace: workspace,
                member: member,
                displayName: Self.workHostDisplayName,
                capabilities: Self.workHostCapabilities,
                backend: backend
            )
            guard workspaceId == workspace, memberId == member else { return }
            hostRegistrationState = .ready(host)
            if lastIssue == .hostRegistrationFailed || lastIssue == .hostIdentityUnavailable {
                lastIssue = nil
            }
            startHeartbeatLoop(
                workspace: workspace,
                member: member,
                backend: backend,
                sendImmediately: heartbeatImmediately
            )
        } catch is CancellationError {
            return
        } catch let issue as MomoWorkConsoleError {
            guard workspaceId == workspace, memberId == member else { return }
            hostRegistrationState = .failed(issue)
        } catch {
            guard workspaceId == workspace, memberId == member else { return }
            hostRegistrationState = .failed(.hostRegistrationFailed)
        }
    }

    private func startHeartbeatLoop(
        workspace: WorkspaceID,
        member: MemberID,
        backend: any MomoWorkHostBackend,
        sendImmediately: Bool
    ) {
        heartbeatTask?.cancel()
        heartbeatTask = Task { [weak self] in
            if sendImmediately {
                guard let self else { return }
                await self.sendHeartbeat(workspace: workspace, member: member, backend: backend)
            }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(30))
                } catch {
                    return
                }
                guard let self else { return }
                await self.sendHeartbeat(workspace: workspace, member: member, backend: backend)
            }
        }
    }

    private func sendHeartbeat(
        workspace: WorkspaceID,
        member: MemberID,
        backend: any MomoWorkHostBackend
    ) async {
        guard workspaceId == workspace,
              memberId == member,
              let hostId
        else { return }
        do {
            let sentAtMs = Int64(Date().timeIntervalSince1970 * 1_000)
            let host = try await workHostRegistrar.heartbeat(
                workspace: workspace,
                host: hostId,
                sentAtMs: sentAtMs,
                backend: backend
            )
            guard workspaceId == workspace, memberId == member else { return }
            hostRegistrationState = .ready(host)
            hostHeartbeatIssue = nil
        } catch is CancellationError {
            return
        } catch let BackendError.problem(status, _, _) where status == 401 {
            guard workspaceId == workspace, memberId == member else { return }
            await reconcileWorkHost(
                workspace: workspace,
                member: member,
                heartbeatImmediately: false
            )
        } catch {
            guard workspaceId == workspace, memberId == member,
                  let host = hostRegistrationState.host
            else { return }
            hostRegistrationState = .ready(host.momoWithOnline(false))
            hostHeartbeatIssue = .hostHeartbeatFailed
        }
    }

    private static var workHostDisplayName: String {
        let deviceName = Host.current().localizedName?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let deviceName, !deviceName.isEmpty else { return "Momo for Mac" }
        return String("Momo on \(deviceName)".prefix(80))
    }

    private static var workHostCapabilities: [String: Bool] {
        [
            "work.control.realtime": true,
            "work.tool-profile": true,
            "work.acp": true,
        ]
    }
}
