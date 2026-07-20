import Foundation
import MomoCore

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
    @Published private(set) var pendingReads: [WorkSessionID: MomoPendingWorkRead] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isStarting = false
    @Published private(set) var lastIssue: MomoWorkConsoleError?
    @Published private(set) var autoApproveStates: [MomoWorkTool: MomoWorkAutoApproveState] = [:]
    @Published private(set) var hostRegistrationState: MomoWorkHostRegistrationState = .waitingForSession
    @Published private(set) var hostHeartbeatIssue: MomoWorkConsoleError?

    private let viewModel: ChatViewModel
    private let workHostRegistrar: MomoWorkHostRegistrar
    private var workspaceId: WorkspaceID?
    private var memberId: MemberID?
    private var handledControlIds: Set<WorkControlID> = []
    private var endingSessionIds: Set<WorkSessionID> = []
    private var heartbeatTask: Task<Void, Never>?

    init(
        viewModel: ChatViewModel,
        workHostRegistrar: MomoWorkHostRegistrar = MomoWorkHostRegistrar(),
        initialHostRegistrationState: MomoWorkHostRegistrationState = .waitingForSession
    ) {
        self.viewModel = viewModel
        self.workHostRegistrar = workHostRegistrar
        self.hostRegistrationState = initialHostRegistrationState
        for tool in MomoWorkTool.allCases {
            autoApproveStates[tool] = .unknown
        }
    }

    var supportsWorkConsole: Bool { viewModel.supportsWorkConsole }

    var hostId: WorkHostID? { hostRegistrationState.host?.id }

    var isHostReady: Bool { hostRegistrationState.host != nil }

    var selectedSession: MomoWorkSession? {
        guard let selectedSessionId else { return nil }
        return sessions.first { $0.id == selectedSessionId }
    }

    var selectedLocalSession: MomoLocalTerminalSession? {
        selectedSessionId.flatMap { localSessions[$0] }
    }

    func owns(_ session: MomoWorkSession) -> Bool {
        session.memberId == viewModel.currentNavigationMemberID
    }

    func activate(workspace nextWorkspace: WorkspaceID?, member nextMember: MemberID?) async {
        if workspaceId != nextWorkspace || memberId != nextMember {
            heartbeatTask?.cancel()
            heartbeatTask = nil
            localSessions.values.forEach { $0.terminate() }
            localSessions = [:]
            pendingReads = [:]
            handledControlIds = []
            sessions = []
            selectedSessionId = nil
            workspaceId = nextWorkspace
            memberId = nextMember
            hostRegistrationState = .waitingForSession
            hostHeartbeatIssue = nil
        }
        guard let nextWorkspace, let nextMember else {
            if nextWorkspace == nil { lastIssue = .noWorkspace }
            return
        }
        await reconcileWorkHost(workspace: nextWorkspace, member: nextMember)
        await refresh()
    }

    func retryWorkHostRegistration() async {
        guard let workspaceId, let memberId else { return }
        await reconcileWorkHost(workspace: workspaceId, member: memberId)
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
        directory: URL?
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
            _ = try MomoWorkLaunchSpec.resolve(tool: tool)
            let session = try await createAndLaunch(
                channel: channel,
                tool: tool,
                label: label,
                directory: directory
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

    func endSession(_ session: MomoWorkSession) async {
        guard !endingSessionIds.contains(session.id) else { return }
        endingSessionIds.insert(session.id)
        defer { endingSessionIds.remove(session.id) }
        localSessions[session.id]?.terminate()
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
        case .control(let delta):
            guard let hostId else { return }
            guard delta.action == .dispatched,
                  delta.targetHostId == hostId,
                  !handledControlIds.contains(delta.controlId)
            else { return }
            handledControlIds.insert(delta.controlId)
            await execute(delta)
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

    func shutdown() async {
        heartbeatTask?.cancel()
        heartbeatTask = nil
        let running = sessions.filter { $0.isRunning && localSessions[$0.id] != nil }
        let runningIDs = Set(running.map(\.id))
        endingSessionIds.formUnion(runningIDs)
        defer { endingSessionIds.subtract(runningIDs) }
        localSessions.values.forEach { $0.terminate() }
        for session in running {
            _ = try? await viewModel.endWorkSession(session.id, exitCode: nil)
        }
        localSessions = [:]
        pendingReads = [:]
    }

    private func createAndLaunch(
        channel: ChannelID,
        tool: MomoWorkTool,
        label: String,
        directory: URL?
    ) async throws -> MomoWorkSession {
        guard let hostId else { throw MomoWorkConsoleError.hostRegistrationFailed }
        let session = try await viewModel.createWorkSession(
            channel: channel,
            host: hostId,
            tool: tool,
            label: label
        )
        let local = MomoLocalTerminalSession { [weak self] exitCode in
            guard let self else { return }
            Task { await self.localProcessEnded(session.id, exitCode: exitCode) }
        }
        do {
            try local.start(tool: tool, directory: directory)
        } catch {
            _ = try? await viewModel.endWorkSession(session.id, exitCode: nil)
            throw error
        }
        localSessions[session.id] = local
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
              let tool = MomoWorkTool(rawValue: rawTool),
              let rawLabel = control.payload["label"]?.stringValue
        else { throw MomoWorkConsoleError.localLaunchFailed }
        _ = try MomoWorkLaunchSpec.resolve(tool: tool)
        let session = try await createAndLaunch(
            channel: control.channelId,
            tool: tool,
            label: Self.normalizedLabel(rawLabel, tool: tool, directory: nil),
            directory: nil
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
              let local = localSessions[sessionId],
              local.isRunning,
              let text = control.payload["text"]?.stringValue,
              !text.isEmpty
        else { throw MomoWorkConsoleError.sessionUnavailable }
        local.sendInput(text)
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
              localSessions[sessionId] != nil
        else { throw MomoWorkConsoleError.sessionUnavailable }
        guard !endingSessionIds.contains(sessionId) else {
            throw MomoWorkConsoleError.sessionUnavailable
        }
        endingSessionIds.insert(sessionId)
        defer { endingSessionIds.remove(sessionId) }
        localSessions[sessionId]?.terminate()
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
        var capabilities = ["work.control.realtime": true]
        for tool in MomoWorkTool.allCases {
            capabilities["tool.\(tool.rawValue)"] =
                (try? MomoWorkLaunchSpec.resolve(tool: tool)) != nil
        }
        return capabilities
    }
}
