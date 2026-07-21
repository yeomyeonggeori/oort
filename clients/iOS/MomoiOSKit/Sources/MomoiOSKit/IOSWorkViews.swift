#if os(iOS)
import MomoCore
import SwiftUI

@MainActor
struct IOSWorkView: View {
    @Bindable var model: IOSWorkListModel
    @Bindable var approvalModel: IOSWorkApprovalInboxModel
    let channelIDs: [ChannelID]
    let isActive: Bool
    let currentMemberID: MemberID
    let workspace: WorkspaceID
    let members: [MemberID: Member]
    let backend: MomoServerConversationClient
    @Binding var developerModeEnabled: Bool

    var body: some View {
        List {
            if let message = model.inlineFailureMessage {
                Section {
                    Label(message, systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.secondary)
                    Button("Retry") { Task { await model.retry() } }
                }
                .accessibilityIdentifier("workInlineFailure")
            }

            if let message = approvalModel.inlineFailureMessage {
                Section {
                    Label(message, systemImage: "wifi.exclamationmark")
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("workApprovalInlineFailure")
            }

            if !approvalModel.messages.isEmpty {
                Section("Needs approval") {
                    ForEach(approvalModel.messages) { message in
                        IOSApprovalDecisionCard(
                            message: message,
                            status: approvalModel.status(for: message),
                            isInFlight: approvalID(for: message).map(approvalModel.decisionsInFlight.contains) == true,
                            didFail: approvalID(for: message).map(approvalModel.decisionFailures.contains) == true,
                            onDecide: { approve in
                                Task { await approvalModel.decide(message, approve: approve) }
                            },
                            onRetry: { Task { await approvalModel.retry(message) } }
                        )
                        .accessibilityIdentifier("workApproval.\(message.id.description.lowercased())")
                    }
                }
            }

            switch model.phase {
            case .loading:
                Section { ProgressView("Loading Work sessions") }
            case .failed(let failure):
                Section { failureView(failure) }
            case .loaded:
                if developerModeEnabled {
                    if let pool = model.pool {
                        Section { IOSWorkPoolRow(pool: pool) }
                    }
                    developerSessionContent
                } else {
                    Section {
                        IOSWorkSummaryCard(summary: model.summary)
                    } header: {
                        Text("Background work")
                    } footer: {
                        Text("Turn on Developer Mode in Profile to inspect individual sessions.")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Work")
        .refreshable {
            await model.retry()
            await approvalModel.refresh(channelIDs: channelIDs)
        }
        .task(id: isActive) {
            guard isActive else { return }
            await model.start(channelIDs: channelIDs)
        }
        .task(id: "work-approvals-\(isActive)") {
            guard isActive else { return }
            await approvalModel.start(channelIDs: channelIDs)
        }
    }

    @ViewBuilder
    private var developerSessionContent: some View {
        Section {
            Picker("Session filter", selection: $model.filter) {
                Text("All").tag(IOSWorkFilter.all)
                Text("Running").tag(IOSWorkFilter.running)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("workFilter")
        }

        if model.visibleSessions.isEmpty {
            Section {
                ContentUnavailableView {
                    Label(
                        model.filter == .running ? "No running sessions" : "No work sessions",
                        systemImage: "terminal"
                    )
                } description: {
                    Text("Sessions started on a connected host will appear here.")
                }
                .accessibilityIdentifier("workEmpty")
            }
        } else {
            Section("Sessions") {
                ForEach(model.visibleSessions) { session in
                    NavigationLink {
                        IOSWorkSessionDetailView(
                            session: session,
                            host: model.host(for: session),
                            currentMemberID: currentMemberID,
                            workspace: workspace,
                            members: members,
                            backend: backend
                        )
                    } label: {
                        IOSWorkSessionRow(session: session, host: model.host(for: session))
                    }
                    .accessibilityIdentifier("workSession.\(session.id.description.lowercased())")
                }
            }
        }
    }

    private func approvalID(for message: Message) -> ApprovalID? {
        IOSTimelineModel.approvalID(for: message)
    }

    private func failureView(_ failure: IOSWorkListModel.Failure) -> some View {
        ContentUnavailableView {
            Label(
                failure.isOffline ? "Work unavailable offline" : "Could not load Work",
                systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
            )
        } description: {
            Text(failure.message)
        } actions: {
            Button("Retry loading Work") { Task { await model.retry() } }
        }
        .accessibilityIdentifier("workFailure")
    }
}

@MainActor
private struct IOSWorkSessionDetailView: View {
    let session: IOSWorkSession
    let host: WorkHost?
    let members: [MemberID: Member]
    @State private var timelineModel: IOSTimelineModel
    @State private var autoApprovalModel: IOSWorkAutoApprovalModel
    @State private var selectedAgentID: MemberID?
    @State private var presentedInteraction: IOSMessageInteractionPresentation?

    init(
        session: IOSWorkSession,
        host: WorkHost?,
        currentMemberID: MemberID,
        workspace: WorkspaceID,
        members: [MemberID: Member],
        backend: MomoServerConversationClient
    ) {
        self.session = session
        self.host = host
        self.members = members
        let agents = members.values.filter { $0.kind == .agent && $0.status == .active }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        let initialAgent = agents.count == 1 ? agents[0] : nil
        _selectedAgentID = State(initialValue: initialAgent?.id)
        _timelineModel = State(initialValue: IOSTimelineModel(
            channel: session.channelId,
            currentMemberID: currentMemberID,
            backend: backend,
            workspace: workspace,
            threadRoot: session.rootMessageId,
            workAgentMemberID: initialAgent?.id,
            workAgentHandle: initialAgent?.handle,
            workSessionID: session.id
        ))
        _autoApprovalModel = State(initialValue: IOSWorkAutoApprovalModel(backend: backend))
    }

    private var agents: [Member] {
        members.values.filter { $0.kind == .agent && $0.status == .active }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    var body: some View {
        List {
            sessionSection
            controlSection
            if timelineModel.realtimeStatus.isFallbackActive, timelineModel.phase == .loaded {
                Section {
                    Label("Live updates unavailable. Pull to refresh the Work thread.", systemImage: "wifi.slash")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("workDetailRealtimeFallback")
            }
            timelineContent
            if !timelineModel.agentPartials.isEmpty {
                Section("In progress") {
                    ForEach(timelineModel.agentPartials) { partial in
                        IOSWorkAgentPartialCard(partial: partial)
                    }
                }
            }
        }
        .listStyle(.plain)
        .safeAreaInset(edge: .bottom) {
            IOSMessageComposer(model: timelineModel)
        }
        .navigationTitle(session.label)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await timelineModel.retry()
            await autoApprovalModel.load()
        }
        .task {
            await autoApprovalModel.load()
            await timelineModel.load()
        }
        .onChange(of: selectedAgentID) { _, selectedID in
            timelineModel.configureWorkAgent(selectedID.flatMap { members[$0] })
        }
        .sheet(item: $presentedInteraction) { presentation in
            IOSMessageInteractionSheet(messageID: presentation.id, model: timelineModel)
        }
        .onDisappear { Task { await timelineModel.shutdown() } }
    }

    private var sessionSection: some View {
        Section {
            LabeledContent("Status", value: session.status.label)
            LabeledContent("Tool", value: session.tool.rawValue.capitalized)
            LabeledContent("Host", value: host?.displayName ?? "Unknown host")
            LabeledContent("Started", value: startedDate.formatted(date: .abbreviated, time: .shortened))
            LabeledContent("Elapsed", value: session.elapsedDescription())
        } header: {
            Label("Session", systemImage: session.tool.systemImage)
        }
    }

    private var controlSection: some View {
        Section {
            if agents.isEmpty {
                Label("No active agent is available for Work input.", systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if agents.count > 1 {
                Picker("Agent", selection: $selectedAgentID) {
                    Text("Choose an agent").tag(nil as MemberID?)
                    ForEach(agents) { agent in
                        Text(agent.displayName).tag(agent.id as MemberID?)
                    }
                }
                .accessibilityIdentifier("workAgentPicker")
            } else if let agent = agents.first {
                LabeledContent("Agent", value: agent.displayName)
            }

            Button {
                Task { await timelineModel.requestCurrentWorkOutput() }
            } label: {
                Label("Show current output", systemImage: "text.viewfinder")
            }
            .disabled(selectedAgentID == nil || !session.isRunning || timelineModel.isSending)
            .accessibilityIdentifier("workRead.\(session.id.description.lowercased())")

            if autoApprovalModel.hasLoadedSnapshot {
                Toggle(
                    "Auto-approve \(session.tool.rawValue)",
                    isOn: Binding(
                        get: { autoApprovalModel.enabledTools.contains(session.tool) },
                        set: { enabled in
                            Task { await autoApprovalModel.set(session.tool, enabled: enabled) }
                        }
                    )
                )
                .disabled(autoApprovalModel.mutationInFlight != nil)
                .accessibilityIdentifier("workAutoApprove.\(session.tool.rawValue)")
            } else if !autoApprovalModel.isLoading {
                Button("Retry auto-approve setting") {
                    Task { await autoApprovalModel.load() }
                }
                .accessibilityIdentifier("workAutoApproveRetry")
            }

            if autoApprovalModel.isLoading && !autoApprovalModel.hasLoadedSnapshot {
                ProgressView("Loading auto-approve setting")
            }
            if let message = autoApprovalModel.inlineFailureMessage {
                Label(message, systemImage: "exclamationmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Intervene")
        } footer: {
            Text("Input and read requests are written to this public session thread. Raw terminal output stays on the host until the agent shares a reviewed excerpt.")
        }
    }

    @ViewBuilder
    private var timelineContent: some View {
        switch timelineModel.phase {
        case .loading:
            Section { ProgressView("Loading session thread") }
        case .failed(let failure):
            Section {
                ContentUnavailableView {
                    Label(
                        failure.isOffline ? "Work thread unavailable offline" : "Could not load Work thread",
                        systemImage: failure.isOffline ? "wifi.slash" : "exclamationmark.triangle"
                    )
                } description: {
                    Text(failure.message)
                } actions: {
                    Button("Retry") { Task { await timelineModel.retry() } }
                }
            }
        case .loaded where timelineModel.messages.isEmpty && timelineModel.agentPartials.isEmpty:
            Section {
                ContentUnavailableView(
                    "No session updates yet",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("Send feedback below or request the current output.")
                )
            }
        case .loaded:
            ForEach(timelineModel.presentationRows) { row in
                timelineRow(row)
            }
        }
    }

    @ViewBuilder
    private func timelineRow(_ row: IOSTimelineDisplayRow) -> some View {
        switch row.content {
        case .date(let dayStartMs):
            IOSMessageDateDivider(dayStartMs: dayStartMs)
                .listRowSeparator(.hidden)
        case .message(let message, let startsAuthorGroup, let mentionsCurrentMember, let bodySegments):
            IOSMessageRow(
                message: message,
                member: members[message.authorMemberId],
                quotedBody: quotedBody(for: message),
                startsAuthorGroup: startsAuthorGroup,
                mentionsCurrentMember: mentionsCurrentMember,
                bodySegments: bodySegments,
                model: timelineModel
            )
            .listRowSeparator(.hidden)
            .listRowBackground(mentionsCurrentMember ? Color.accentColor.opacity(0.10) : Color.clear)
            .onLongPressGesture {
                guard timelineModel.canPresentInteractionSheet(for: message) else { return }
                presentedInteraction = IOSMessageInteractionPresentation(id: message.id)
            }
        }
    }

    private func quotedBody(for message: Message) -> String? {
        let replyID = message.replyToId
            ?? message.props["reply_to_id"]?.stringValue.flatMap(MessageID.init(uuidString:))
        return replyID.flatMap { id in timelineModel.messages.first(where: { $0.id == id })?.body }
    }

    private var startedDate: Date {
        Date(timeIntervalSince1970: TimeInterval(session.startedAtMs) / 1_000)
    }
}

private struct IOSWorkAgentPartialCard: View {
    let partial: IOSAgentPartialProjection

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Agent is working", systemImage: "sparkles")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let tool = partial.toolCallName {
                Label(tool, systemImage: "wrench.and.screwdriver")
                    .font(.caption.monospaced())
            }
            if !partial.text.isEmpty {
                Text(partial.text)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("workPartial.\(partial.id.description.lowercased())")
    }
}

private struct IOSWorkPoolRow: View {
    let pool: IOSWorkPool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Work pool", systemImage: "square.stack.3d.up")
                    .font(.headline)
                Spacer()
                Text("\(pool.activeSessions) / \(pool.maxActive) slots")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            ProgressView(
                value: Double(min(pool.activeSessions, pool.maxActive)),
                total: Double(max(pool.maxActive, 1))
            )
            Text("Your active sessions: \(pool.memberActiveSessions) of \(pool.perMemberSoftLimit)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("workPool")
    }
}

private struct IOSWorkSummaryCard: View {
    let summary: IOSWorkSummary

    var body: some View {
        HStack(spacing: 12) {
            summaryMetric(
                value: summary.runningCount,
                label: "Running",
                systemImage: "play.circle.fill",
                color: .accentColor
            )
            Divider()
            summaryMetric(
                value: summary.completedCount,
                label: "Completed",
                systemImage: "checkmark.circle.fill",
                color: .secondary
            )
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("workSummary")
    }

    private func summaryMetric(
        value: Int,
        label: String,
        systemImage: String,
        color: Color
    ) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                Text(value, format: .number)
                    .font(.title2.weight(.semibold).monospacedDigit())
                Text(label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct IOSWorkSessionRow: View {
    let session: IOSWorkSession
    let host: WorkHost?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            toolIcon
            VStack(alignment: .leading, spacing: 7) {
                Text(session.label)
                    .font(.headline)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    statusChip
                    hostLabel
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        startedLabel
                        Text("·").foregroundStyle(.tertiary)
                        elapsedLabel
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        startedLabel
                        elapsedLabel
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var toolIcon: some View {
        Image(systemName: session.tool.systemImage)
            .font(.body.weight(.semibold))
            .frame(width: 38, height: 38)
            .foregroundStyle(.primary)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityHidden(true)
    }

    private var statusChip: some View {
        Text(session.status.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(session.status.tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(session.status.tint.opacity(0.12), in: Capsule())
    }

    private var hostLabel: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(host?.online == true ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
            Text(host?.displayName ?? "Unknown host")
                .lineLimit(1)
            Text(host?.online == true ? "Connected" : "Offline")
                .foregroundStyle(.tertiary)
        }
        .font(.caption)
    }

    private var startedLabel: some View {
        Text("Started \(startedDate.formatted(date: .abbreviated, time: .shortened))")
    }

    @ViewBuilder
    private var elapsedLabel: some View {
        if session.isRunning {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(session.elapsedDescription(now: context.date))
                    .monospacedDigit()
            }
        } else {
            Text(session.elapsedDescription())
                .monospacedDigit()
        }
    }

    private var startedDate: Date {
        Date(timeIntervalSince1970: TimeInterval(session.startedAtMs) / 1_000)
    }
}

private extension IOSWorkSessionTool {
    var systemImage: String {
        switch self {
        case .claude: "sparkles"
        case .codex: "terminal"
        case .opencode: "chevron.left.forwardslash.chevron.right"
        case .shell: "apple.terminal"
        }
    }
}

private extension IOSWorkSessionStatus {
    var label: String {
        switch self {
        case .running: "Running"
        case .orphaned: "Needs host"
        case .ended: "Ended"
        }
    }

    var tint: Color {
        switch self {
        case .running: .accentColor
        case .orphaned: .orange
        case .ended: .secondary
        }
    }
}
#endif
