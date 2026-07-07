import SwiftUI
import MomoCore

public enum AlphaCommandCenterArea: String, CaseIterable, Sendable, Hashable {
    case server = "Server"
    case realtime = "Realtime"
    case agentRuntime = "Agent Runtime"
    case providerSetup = "Provider Setup"
    case invites = "Invites"
    case diagnostics = "Diagnostics"
    case updates = "Updates"
}

public enum AlphaCommandCenterHealth: String, Sendable, Hashable {
    case ready = "Ready"
    case working = "Working"
    case degraded = "Degraded"
    case blocked = "Blocked"
    case planned = "Planned"
}

public struct AlphaCommandCenterStatus: Identifiable, Sendable, Hashable {
    public var area: AlphaCommandCenterArea
    public var health: AlphaCommandCenterHealth
    public var detail: String
    public var recovery: String?

    public var id: AlphaCommandCenterArea { area }

    public init(
        area: AlphaCommandCenterArea,
        health: AlphaCommandCenterHealth,
        detail: String,
        recovery: String? = nil
    ) {
        self.area = area
        self.health = health
        self.detail = detail
        self.recovery = recovery
    }
}

public enum AlphaChecklistState: String, Sendable, Hashable {
    case done = "Done"
    case ready = "Ready"
    case blocked = "Blocked"
}

public struct AlphaChecklistItem: Identifiable, Sendable, Hashable {
    public var id: String
    public var title: String
    public var state: AlphaChecklistState
    public var detail: String

    public init(id: String, title: String, state: AlphaChecklistState, detail: String) {
        self.id = id
        self.title = title
        self.state = state
        self.detail = detail
    }
}

public struct AlphaCapabilityItem: Identifiable, Sendable, Hashable {
    public var id: String
    public var title: String
    public var detail: String
    public var isAvailable: Bool

    public init(id: String, title: String, detail: String, isAvailable: Bool) {
        self.id = id
        self.title = title
        self.detail = detail
        self.isAvailable = isAvailable
    }
}

public struct AlphaCommandCenterSnapshot: Sendable, Hashable {
    public var statuses: [AlphaCommandCenterStatus]
    public var checklist: [AlphaChecklistItem]
    public var capabilities: [AlphaCapabilityItem]
    public var limitations: [String]

    public init(
        statuses: [AlphaCommandCenterStatus],
        checklist: [AlphaChecklistItem],
        capabilities: [AlphaCapabilityItem],
        limitations: [String]
    ) {
        self.statuses = statuses
        self.checklist = checklist
        self.capabilities = capabilities
        self.limitations = limitations
    }

    public var attentionCount: Int {
        statuses.filter { $0.health == .degraded || $0.health == .blocked }.count
    }

    public static func make(
        workspaceId: WorkspaceID?,
        channels: [Channel],
        selectedChannel: Channel?,
        selectedRealtimeStatus: RealtimeConnectionStatus?,
        agentRuntimeStatus: AgentRuntimeStatus,
        inviteJoinState: InviteJoinState,
        connectionError: String?,
        visibleMessageCount: Int,
        pendingApprovalCount: Int,
        liveSpentMicroUSD: Int64,
        updateStatus: MomoMacUpdateChannelStatus
    ) -> AlphaCommandCenterSnapshot {
        let serverStatus = server(
            workspaceId: workspaceId,
            channelCount: channels.count,
            connectionError: connectionError
        )
        let realtimeStatus = realtime(
            selectedChannel: selectedChannel,
            status: selectedRealtimeStatus
        )
        let agentStatus = agentRuntime(agentRuntimeStatus)
        let providerSetupStatus = providerSetup(agentRuntimeStatus)
        let inviteStatus = invites(inviteJoinState, workspaceId: workspaceId)
        let diagnosticsStatus = diagnostics(connectionError: connectionError)
        let updateStatusItem = updates(updateStatus)

        let statuses = [
            serverStatus,
            realtimeStatus,
            agentStatus,
            providerSetupStatus,
            inviteStatus,
            diagnosticsStatus,
            updateStatusItem,
        ]

        let hasChannels = !channels.isEmpty
        let hasSelectedChannel = selectedChannel != nil
        let agentUsable = agentRuntimeStatus.availability == .available || agentRuntimeStatus.availability == .mock
        let inviteBlocked: Bool
        if case .failed = inviteJoinState {
            inviteBlocked = true
        } else {
            inviteBlocked = false
        }

        return AlphaCommandCenterSnapshot(
            statuses: statuses,
            checklist: [
                AlphaChecklistItem(
                    id: "open-agent-lab",
                    title: "Open #agent-lab",
                    state: hasSelectedChannel ? .done : (hasChannels ? .ready : .blocked),
                    detail: selectedChannel?.name.map { "Selected #\($0)" } ?? "Load channels, then select the Hermes test channel."
                ),
                AlphaChecklistItem(
                    id: "send-message",
                    title: "Send one human message",
                    state: visibleMessageCount > 0 ? .done : (hasSelectedChannel ? .ready : .blocked),
                    detail: visibleMessageCount > 0
                        ? "\(visibleMessageCount) timeline item(s) loaded for the selected channel."
                        : "Use the composer and confirm ordered message.seq history."
                ),
                AlphaChecklistItem(
                    id: "mention-hermes",
                    title: "Mention @hermes",
                    state: agentUsable && hasSelectedChannel ? .ready : .blocked,
                    detail: agentUsable
                        ? "Mock or available provider is enough for local alpha."
                        : "Fix Agent Runtime before treating a missing response as an app bug."
                ),
                AlphaChecklistItem(
                    id: "credentialed-hermes",
                    title: "Connect real local Hermes",
                    state: credentialedHermesState(agentRuntimeStatus, hasSelectedChannel: hasSelectedChannel),
                    detail: credentialedHermesDetail(agentRuntimeStatus)
                ),
                AlphaChecklistItem(
                    id: "invite-join",
                    title: "Exercise invite or join",
                    state: inviteBlocked ? .blocked : (workspaceId == nil ? .blocked : .ready),
                    detail: inviteDetail(inviteJoinState)
                ),
                AlphaChecklistItem(
                    id: "approval-cost",
                    title: "Check approvals and cost",
                    state: pendingApprovalCount > 0 || liveSpentMicroUSD > 0 ? .done : (hasSelectedChannel ? .ready : .blocked),
                    detail: pendingApprovalCount > 0
                        ? "\(pendingApprovalCount) pending approval(s); live spend \(CostFormat.usdCompact(liveSpentMicroUSD))."
                        : "Open D/B/C fixture channels and confirm approval/cost surfaces are visible."
                ),
                AlphaChecklistItem(
                    id: "diagnostics",
                    title: "Collect diagnostics after a failure",
                    state: .ready,
                    detail: "Use the diagnostics bundle before restarting failed server, relay, worker, or app processes."
                ),
            ],
            capabilities: [
                AlphaCapabilityItem(
                    id: "chat",
                    title: "Channel history and send",
                    detail: hasSelectedChannel ? "Available in the selected channel." : "Requires a loaded channel.",
                    isAvailable: hasSelectedChannel
                ),
                AlphaCapabilityItem(
                    id: "realtime",
                    title: "Live or REST-backed timeline",
                    detail: selectedRealtimeStatus?.isLive == true
                        ? "Live Centrifugo subscription is active."
                        : "REST fallback is valid for local alpha when it is clearly shown.",
                    isAvailable: selectedRealtimeStatus?.isLive == true || selectedRealtimeStatus?.isFallbackActive == true
                ),
                AlphaCapabilityItem(
                    id: "agent-runtime",
                    title: "Hermes bridge",
                    detail: agentRuntimeStatus.internalAlphaProviderSummary,
                    isAvailable: agentUsable
                ),
                AlphaCapabilityItem(
                    id: "credential-boundary",
                    title: "Provider credential boundary",
                    detail: "Codex/OpenAI OAuth stays in the local provider; momo receives only endpoint, Hermes bearer, context, usage, and audit evidence.",
                    isAvailable: true
                ),
                AlphaCapabilityItem(
                    id: "invites",
                    title: "Invite and join smoke",
                    detail: inviteDetail(inviteJoinState),
                    isAvailable: !inviteBlocked && workspaceId != nil
                ),
                AlphaCapabilityItem(
                    id: "diagnostics",
                    title: "Diagnostics bundle",
                    detail: "Repo-local collector and local gate evidence are available.",
                    isAvailable: true
                ),
                AlphaCapabilityItem(
                    id: "updates",
                    title: "Alpha update readiness",
                    detail: updateStatus.surfaceDetail,
                    isAvailable: updateStatus.state != .failed
                ),
            ],
            limitations: [
                "Automatic update install and Sparkle appcast proof wait for signed/notarized M4 artifacts.",
                "AWS/public host, DNS/TLS, registry pull, SOPS, and pgBackRest host evidence remain outside this app surface.",
                "Real Hermes/Codex OAuth side effects need MOMO-257 credentialed provider evidence; repo-local mock remains the deterministic default.",
                "iOS, APNs, enterprise SSO, and full channel settings/search/archive are not part of this alpha app.",
            ]
        )
    }

    private static func server(
        workspaceId: WorkspaceID?,
        channelCount: Int,
        connectionError: String?
    ) -> AlphaCommandCenterStatus {
        if let connectionError {
            return AlphaCommandCenterStatus(
                area: .server,
                health: workspaceId == nil ? .blocked : .degraded,
                detail: "Recoverable error: \(short(connectionError))",
                recovery: "Retry the selected channel or switch sessions after checking MomoServer."
            )
        }
        guard let workspaceId else {
            return AlphaCommandCenterStatus(
                area: .server,
                health: .working,
                detail: "No active workspace session yet.",
                recovery: "Open demo mode or sign in to a local MomoServer."
            )
        }
        return AlphaCommandCenterStatus(
            area: .server,
            health: .ready,
            detail: "Workspace \(String(workspaceId.description.prefix(8))) connected with \(channelCount) channel(s)."
        )
    }

    private static func realtime(
        selectedChannel: Channel?,
        status: RealtimeConnectionStatus?
    ) -> AlphaCommandCenterStatus {
        guard let selectedChannel else {
            return AlphaCommandCenterStatus(
                area: .realtime,
                health: .working,
                detail: "No selected channel.",
                recovery: "Select a channel to start live subscription or REST fallback."
            )
        }
        guard let status else {
            return AlphaCommandCenterStatus(
                area: .realtime,
                health: .working,
                detail: "Waiting for \(channelName(selectedChannel)) realtime state."
            )
        }
        if status.isLive {
            return AlphaCommandCenterStatus(
                area: .realtime,
                health: .ready,
                detail: "Live subscription active for \(channelName(selectedChannel))."
            )
        }
        if status.isFallbackActive {
            return AlphaCommandCenterStatus(
                area: .realtime,
                health: status.connection == .error || status.subscription == .error ? .degraded : .working,
                detail: "REST history fallback for \(channelName(selectedChannel)): \(short(status.message ?? status.connection.rawValue))",
                recovery: status.canRetry ? "Use Retry after Centrifugo or network recovery." : nil
            )
        }
        return AlphaCommandCenterStatus(
            area: .realtime,
            health: .working,
            detail: "\(status.connection.rawValue) / \(status.subscription.rawValue) for \(channelName(selectedChannel))."
        )
    }

    private static func agentRuntime(_ status: AgentRuntimeStatus) -> AlphaCommandCenterStatus {
        switch status.availability {
        case .available, .mock:
            return AlphaCommandCenterStatus(
                area: .agentRuntime,
                health: .ready,
                detail: status.internalAlphaProviderSummary
            )
        case .degraded:
            return AlphaCommandCenterStatus(
                area: .agentRuntime,
                health: .degraded,
                detail: status.internalAlphaProviderSummary,
                recovery: status.diagnostics.first ?? "Check provider mode, endpoint, and key configuration."
            )
        case .unknown:
            return AlphaCommandCenterStatus(
                area: .agentRuntime,
                health: .working,
                detail: status.internalAlphaProviderSummary,
                recovery: "Refresh Hermes status after connecting to the server."
            )
        }
    }

    private static func providerSetup(_ status: AgentRuntimeStatus) -> AlphaCommandCenterStatus {
        switch status.availability {
        case .available:
            let detail = status.mode == .gateway
                ? "Hermes gateway delivery is configured. Provider OAuth stays inside the local Hermes runtime: \(status.internalAlphaProviderSummary)"
                : "Credentialed Hermes-compatible provider is connected: \(status.internalAlphaProviderSummary)"
            return AlphaCommandCenterStatus(
                area: .providerSetup,
                health: .ready,
                detail: detail
            )
        case .mock:
            return AlphaCommandCenterStatus(
                area: .providerSetup,
                health: .working,
                detail: "Repo-local Hermes mock is active.",
                recovery: "For real GPT/Codex behavior, run scripts/verify_local_hermes_credentialed_smoke.sh after user-owned provider login."
            )
        case .degraded:
            return AlphaCommandCenterStatus(
                area: .providerSetup,
                health: .degraded,
                detail: status.internalAlphaProviderSummary,
                recovery: status.diagnostics.first ?? "Open docs/external-agent-provider/local-hermes-codex-oauth-setup.md and verify the local provider endpoint/key."
            )
        case .unknown:
            return AlphaCommandCenterStatus(
                area: .providerSetup,
                health: .working,
                detail: "Credentialed provider has not been checked in this session.",
                recovery: "Use scripts/verify_local_hermes_credentialed_smoke.sh for MOMO-257 evidence."
            )
        }
    }

    private static func credentialedHermesState(
        _ status: AgentRuntimeStatus,
        hasSelectedChannel: Bool
    ) -> AlphaChecklistState {
        switch status.availability {
        case .available:
            return hasSelectedChannel ? .done : .ready
        case .mock:
            return .ready
        case .degraded, .unknown:
            return .blocked
        }
    }

    private static func credentialedHermesDetail(_ status: AgentRuntimeStatus) -> String {
        switch status.availability {
        case .available:
            return "Real provider path is available; now send @hermes in #agent-lab."
        case .mock:
            return "Mock is fine for local dogfood. For AWS_READY, add MOMO-257 credentialed provider evidence."
        case .degraded:
            return "Provider setup is degraded: \(short(status.internalAlphaProviderSummary))"
        case .unknown:
            return "Run the local Hermes/Codex OAuth setup runbook before treating real-provider behavior as verified."
        }
    }

    private static func invites(_ state: InviteJoinState, workspaceId: WorkspaceID?) -> AlphaCommandCenterStatus {
        switch state {
        case .idle:
            return AlphaCommandCenterStatus(
                area: .invites,
                health: workspaceId == nil ? .working : .ready,
                detail: workspaceId == nil ? "Invite flow is waiting for a session." : "Invite/join surfaces are ready for alpha smoke."
            )
        case .validating(let code):
            return AlphaCommandCenterStatus(
                area: .invites,
                health: .working,
                detail: "Checking invite \(code)."
            )
        case .joined(let joined):
            return AlphaCommandCenterStatus(
                area: .invites,
                health: .ready,
                detail: "Joined \(joined.workspace.name) as \(joined.role)."
            )
        case .failed(let failure):
            return AlphaCommandCenterStatus(
                area: .invites,
                health: .degraded,
                detail: failure.reason,
                recovery: failure.recoveryHint ?? "Create a fresh invite and copy the raw code once."
            )
        }
    }

    private static func diagnostics(connectionError: String?) -> AlphaCommandCenterStatus {
        if connectionError != nil {
            return AlphaCommandCenterStatus(
                area: .diagnostics,
                health: .ready,
                detail: "Failure is visible; collect diagnostics before restarting.",
                recovery: "Run scripts/collect_diagnostics.sh from the same worktree."
            )
        }
        return AlphaCommandCenterStatus(
            area: .diagnostics,
            health: .ready,
            detail: "Diagnostics collector and local gate evidence are available."
        )
    }

    private static func updates(_ status: MomoMacUpdateChannelStatus) -> AlphaCommandCenterStatus {
        if !status.diagnostics.isEmpty || status.state == .failed {
            return AlphaCommandCenterStatus(
                area: .updates,
                health: .degraded,
                detail: status.diagnostics.joined(separator: " "),
                recovery: "Use a local path or file:// update manifest and keep signing secrets out of runtime config."
            )
        }

        switch status.state {
        case .updateAvailable:
            return AlphaCommandCenterStatus(
                area: .updates,
                health: .ready,
                detail: status.surfaceDetail,
                recovery: status.canOpenDownload ? "Open the download, install the new build, and relaunch momo." : nil
            )
        case .upToDate:
            return AlphaCommandCenterStatus(
                area: .updates,
                health: .ready,
                detail: status.surfaceDetail
            )
        case .notConfigured:
            return AlphaCommandCenterStatus(
                area: .updates,
                health: .planned,
                detail: status.surfaceDetail,
                recovery: "Set MOMO_UPDATE_MANIFEST_PATH or a file:// MOMO_UPDATE_MANIFEST_URL for dogfood build checks."
            )
        case .failed:
            return AlphaCommandCenterStatus(
                area: .updates,
                health: .degraded,
                detail: status.surfaceDetail,
                recovery: "Fix the update manifest configuration and retry."
            )
        }
    }

    private static func inviteDetail(_ state: InviteJoinState) -> String {
        switch state {
        case .idle:
            return "Create/list/revoke owner invites in the session bar, or join with a copied code."
        case .validating(let code):
            return "Checking \(code)."
        case .joined(let joined):
            return "Joined \(joined.workspace.name); public channels should load next."
        case .failed(let failure):
            return [failure.reason, failure.recoveryHint].compactMap { $0 }.joined(separator: " ")
        }
    }

    private static func channelName(_ channel: Channel) -> String {
        if let name = channel.name, !name.isEmpty {
            return "#\(name)"
        }
        return "selected channel"
    }

    private static func short(_ text: String) -> String {
        let compact = text.replacingOccurrences(of: "\n", with: " ")
        guard compact.count > 120 else { return compact }
        return "\(compact.prefix(117))..."
    }
}

public extension ChatViewModel {
    func alphaCommandCenterSnapshot(
        updateStatus: MomoMacUpdateChannelStatus = .fromEnvironment()
    ) -> AlphaCommandCenterSnapshot {
        AlphaCommandCenterSnapshot.make(
            workspaceId: workspaceId,
            channels: channels,
            selectedChannel: selectedChannel,
            selectedRealtimeStatus: selectedRealtimeStatus,
            agentRuntimeStatus: agentRuntimeStatus,
            inviteJoinState: inviteJoinState,
            connectionError: connectionError,
            visibleMessageCount: visibleMessages.count,
            pendingApprovalCount: pendingApprovals.count,
            liveSpentMicroUSD: liveSpentMicroUSD,
            updateStatus: updateStatus
        )
    }
}

public struct AlphaCommandCenterView: View {
    @ObservedObject var viewModel: ChatViewModel
    var updateStatus: MomoMacUpdateChannelStatus
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue

    public init(
        viewModel: ChatViewModel,
        updateStatus: MomoMacUpdateChannelStatus = .fromEnvironment()
    ) {
        self.viewModel = viewModel
        self.updateStatus = updateStatus
    }

    public var body: some View {
        let snapshot = viewModel.alphaCommandCenterSnapshot(updateStatus: updateStatus)
        let copy = MomoWorkspaceCopy(language: language)

        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header(snapshot, copy: copy)
                statusSection(snapshot.statuses, copy: copy)
                checklistSection(snapshot.checklist, copy: copy)
                capabilitySection(snapshot.capabilities, copy: copy)
                limitationSection(snapshot.limitations, copy: copy)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func header(_ snapshot: AlphaCommandCenterSnapshot, copy: MomoWorkspaceCopy) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(copy.commandCenter)
                    .font(.title3.bold())
                Text(snapshot.attentionCount == 0 ? copy.alphaCenterSubtitleReady : copy.alphaCenterSubtitle(attentionCount: snapshot.attentionCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Label("\(snapshot.statuses.filter { $0.health == .ready }.count)/\(snapshot.statuses.count)", systemImage: "checklist")
                .font(.caption.weight(.semibold))
                .foregroundStyle(snapshot.attentionCount == 0 ? MomoTheme.reversibleGreen : MomoTheme.costAmber)
        }
    }

    private func statusSection(_ statuses: [AlphaCommandCenterStatus], copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.status)
                .font(.headline)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(statuses) { status in
                    statusRow(status)
                    if status.id != statuses.last?.id {
                        Divider()
                    }
                }
            }
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func checklistSection(_ checklist: [AlphaChecklistItem], copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.today)
                .font(.headline)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(checklist) { item in
                    checklistRow(item)
                    if item.id != checklist.last?.id {
                        Divider()
                    }
                }
            }
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func capabilitySection(_ capabilities: [AlphaCapabilityItem], copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.availableNotYet)
                .font(.headline)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(capabilities) { item in
                    capabilityRow(item)
                    if item.id != capabilities.last?.id {
                        Divider()
                    }
                }
            }
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func limitationSection(_ limitations: [String], copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(copy.knownLimits)
                .font(.headline)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(limitations, id: \.self) { limit in
                    Label(limit, systemImage: "minus.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private func statusRow(_ status: AlphaCommandCenterStatus) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: status.health.symbolName)
                .foregroundStyle(status.health.tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(status.area.rawValue)
                        .font(.caption.weight(.semibold))
                    Text(status.health.rawValue)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(status.health.tint.opacity(0.16), in: Capsule())
                        .foregroundStyle(status.health.tint)
                }
                Text(status.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let recovery = status.recovery, !recovery.isEmpty {
                    Text(recovery)
                        .font(.caption2)
                        .foregroundStyle(status.health == .ready ? .secondary : status.health.tint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
    }

    private func checklistRow(_ item: AlphaChecklistItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.state.symbolName)
                .foregroundStyle(item.state.tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.caption.weight(.semibold))
                Text(item.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
    }

    private func capabilityRow(_ item: AlphaCapabilityItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.isAvailable ? "checkmark.circle.fill" : "clock")
                .foregroundStyle(item.isAvailable ? MomoTheme.reversibleGreen : .secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(.caption.weight(.semibold))
                Text(item.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
    }
}

private extension AlphaCommandCenterHealth {
    var symbolName: String {
        switch self {
        case .ready:
            return "checkmark.circle.fill"
        case .working:
            return "clock.arrow.circlepath"
        case .degraded:
            return "exclamationmark.triangle.fill"
        case .blocked:
            return "xmark.octagon.fill"
        case .planned:
            return "calendar.badge.clock"
        }
    }

    var tint: Color {
        switch self {
        case .ready:
            return MomoTheme.reversibleGreen
        case .working:
            return .blue
        case .degraded:
            return MomoTheme.costAmber
        case .blocked:
            return MomoTheme.irreversibleRed
        case .planned:
            return .secondary
        }
    }
}

private extension AlphaChecklistState {
    var symbolName: String {
        switch self {
        case .done:
            return "checkmark.circle.fill"
        case .ready:
            return "circle"
        case .blocked:
            return "exclamationmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .done:
            return MomoTheme.reversibleGreen
        case .ready:
            return .secondary
        case .blocked:
            return MomoTheme.costAmber
        }
    }
}
