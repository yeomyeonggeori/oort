import SwiftUI
import MomoCore

// MARK: - MessageListView  (seq-ordered)
//
// The channel timeline. Ordering authority is Message.seq (L4 §1.2 #3): the
// ViewModel keeps messages seq-sorted, this view just renders them oldest→newest
// and pins live agent partials at the bottom (AgentPartialView). Includes a small
// composer wired to optimistic send.

public struct MessageListView: View {
    @ObservedObject var viewModel: ChatViewModel
    private let onOpenWorkDetail: (RunID) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage("momo.workspace.showQuickStart") private var showQuickStart = true
    @FocusState private var isComposerFocused: Bool
    @State private var isPinnedToTimelineBottom = true
    @State private var isWorkComposerPresented = false
    @State private var initialWorkBrief = ""
    @State private var workCommandDraftToRestore: String?
    @State private var workComposerSessionId = UUID()

    public init(
        viewModel: ChatViewModel,
        onOpenWorkDetail: @escaping (RunID) -> Void = { _ in }
    ) {
        self.viewModel = viewModel
        self.onOpenWorkDetail = onOpenWorkDetail
    }

    public var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        VStack(spacing: 0) {
            header(copy: copy)
            if showQuickStart {
                quickStartCard(copy: copy)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
            if let status = viewModel.selectedRealtimeStatus {
                realtimeStatusBanner(status, copy: copy)
                Divider()
            } else if let error = viewModel.connectionError {
                connectionBanner(error, copy: copy)
                Divider()
            }
            if let notice = viewModel.mentionNotice {
                mentionNoticeBanner(notice)
                Divider()
            }
            Divider()
            timeline(copy: copy)
            Divider()
            composer(copy: copy)
        }
    }

    // MARK: Header (cost chip, experience B social signal)

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func header(copy: MomoWorkspaceCopy) -> some View {
        HStack {
            if let id = viewModel.selectedChannelId,
               let channel = viewModel.channels.first(where: { $0.id == id }) {
                Image(systemName: channel.kind == .dm ? "person.2.fill" : "number")
                    .foregroundStyle(.secondary)
                Text(channel.name ?? "DM")
                    .font(.title3.weight(.semibold))
                if let topic = channel.topic {
                    Text(topic)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            } else {
                Text(copy.selectChannel)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            // Social cost chip (experience B): today's live spend.
            if viewModel.liveSpentMicroUSD > 0 {
                Label(CostFormat.usdCompact(viewModel.liveSpentMicroUSD), systemImage: "dollarsign.circle")
                    .font(.caption)
                    .foregroundStyle(MomoTheme.costAmber)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 16)
    }

    private func quickStartCard(copy: MomoWorkspaceCopy) -> some View {
        HStack(alignment: .top, spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                    .fill(MomoTheme.agentAccent.opacity(0.18))
                Image(systemName: "sparkles")
                    .foregroundStyle(MomoTheme.agentAccent)
                    .font(.body.weight(.bold))
            }
            .frame(width: 32, height: 32)

            VStack(alignment: .leading, spacing: 8) {
                Text(copy.quickStartTitle)
                    .font(.body.weight(.semibold))
                Text(copy.quickStartSubtitle)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    MomoGuideStepPill(index: 1, title: copy.guideStepChannel)
                    MomoGuideStepPill(index: 2, title: copy.guideStepAgent)
                    MomoGuideStepPill(index: 3, title: copy.guideStepApproval)
                }

                HStack(spacing: 8) {
                    Button {
                        insertPreferredAgentMention()
                    } label: {
                        Label(copy.insertAgentMention, systemImage: "at")
                    }
                    .controlSize(.small)
                    .disabled(preferredAgent == nil)

                    Button {
                        viewModel.composerDraft = copy.guideSummaryPromptText
                    } label: {
                        Label(copy.draftSummaryPrompt, systemImage: "text.badge.plus")
                    }
                    .controlSize(.small)
                    .disabled(viewModel.selectedChannelId == nil)
                }
            }

            Spacer(minLength: 0)

            Button {
                showQuickStart = false
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help(copy.dismissGuide)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
    }

    private func realtimeStatusBanner(_ status: RealtimeConnectionStatus, copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: statusIcon(status))
                .foregroundStyle(statusColor(status))
            VStack(alignment: .leading, spacing: 4) {
                Text(statusTitle(status, copy: copy))
                    .font(.caption.weight(.semibold))
                if let message = status.message, !message.isEmpty, !status.isLive {
                    Text(message)
                        .font(.caption2)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if status.canRetry {
                Button {
                    Task { await viewModel.retryRealtime() }
                } label: {
                    Label(copy.retry, systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(statusColor(status).opacity(0.08))
    }

    private func connectionBanner(_ error: String, copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(MomoTheme.costAmber)
            VStack(alignment: .leading, spacing: 4) {
                Text(copy.recoverableError)
                    .font(.caption.weight(.semibold))
                Text(error)
                    .font(.caption2)
                    .lineLimit(2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await viewModel.retrySelectedChannelLoad() }
            } label: {
                Label(copy.retry, systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .font(.caption)
            Button {
                viewModel.clearConnectionError()
            } label: {
                Image(systemName: "xmark.circle")
            }
            .buttonStyle(.borderless)
            .help(copy.dismiss)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(MomoTheme.costAmber.opacity(0.08))
    }

    private func mentionNoticeBanner(_ notice: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "at")
                .foregroundStyle(MomoTheme.agentAccent)
            Text(notice)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(MomoTheme.agentAccent.opacity(0.08))
    }

    private func statusTitle(_ status: RealtimeConnectionStatus, copy: MomoWorkspaceCopy) -> String {
        if status.isLive {
            return copy.live
        }
        switch (status.connection, status.subscription, status.fallback) {
        case (.disabled, .disabled, .restHistory):
            return copy.restFallback
        case (.connecting, _, _), (.connected, .subscribing, _):
            return copy.connectingLive
        case (.reconnecting, _, _), (_, .recovering, _):
            return copy.reconnecting
        case (.offline, _, .restHistory), (_, .unsubscribed, .restHistory):
            return copy.offlineRestFallback
        case (.error, _, .restHistory), (_, .error, .restHistory):
            return copy.liveErrorRestFallback
        default:
            return "Realtime \(status.connection.rawValue)"
        }
    }

    private func statusIcon(_ status: RealtimeConnectionStatus) -> String {
        if status.isLive { return "dot.radiowaves.left.and.right" }
        switch status.connection {
        case .connecting, .reconnecting:
            return "arrow.triangle.2.circlepath"
        case .offline, .disabled:
            return "clock.arrow.circlepath"
        case .error:
            return "wifi.exclamationmark"
        case .connected:
            return status.subscription == .subscribed ? "dot.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right"
        }
    }

    private func statusColor(_ status: RealtimeConnectionStatus) -> Color {
        if status.isLive { return MomoTheme.reversibleGreen }
        switch status.connection {
        case .connecting, .reconnecting:
            return MomoTheme.agentAccent
        case .error:
            return MomoTheme.costAmber
        case .offline, .disabled:
            return .secondary
        case .connected:
            return status.subscription == .error ? MomoTheme.costAmber : MomoTheme.agentAccent
        }
    }

    // MARK: Timeline (seq order)

    private func timeline(copy: MomoWorkspaceCopy) -> some View {
        let entries = AgentWorkTimelinePolicy.entries(
            messages: viewModel.visibleMessages,
            runs: viewModel.visibleWorkRuns
        )
        return GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if viewModel.selectedChannelId != nil,
                           entries.isEmpty,
                           livePartials.isEmpty,
                           viewModel.visibleWorkingAgents.isEmpty {
                            if viewModel.isSelectedChannelHistoryLoading {
                                TimelineLoadingState(copy: copy)
                            } else {
                                TimelineEmptyState(copy: copy) {
                                    isComposerFocused = true
                                }
                            }
                        }

                        ForEach(entries) { entry in
                            switch entry {
                            case .message(let item):
                                messageTimelineItem(item, copy: copy)
                            case .work(let runId, let day, let startsDay):
                                if let run = viewModel.workRun(runId) {
                                    workTimelineItem(
                                        run,
                                        day: day,
                                        startsDay: startsDay,
                                        copy: copy
                                    )
                                }
                            }
                        }

                        if let channel = viewModel.selectedChannelId,
                           viewModel.workRunLoadingChannels.contains(channel) {
                            Label(copy.workHistoryLoading, systemImage: "clock")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 8)
                        } else if let error = viewModel.selectedWorkHistoryError,
                                  viewModel.isWorkSurfaceAvailable {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "exclamationmark.triangle")
                                    .foregroundStyle(MomoTheme.irreversibleRed)
                                Text(copy.workError(error))
                                    .font(.caption)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 8)
                                Button {
                                    Task { await viewModel.retryWorkRuns() }
                                } label: {
                                    Label(copy.retryWorkHistory, systemImage: "arrow.clockwise")
                                        .labelStyle(.iconOnly)
                                }
                                .buttonStyle(.borderless)
                                .help(copy.retryWorkHistory)
                            }
                            .padding(.vertical, 8)
                        }

                        // Live agent partial/status cards remain first-class rows below durable seq-ordered messages.
                        ForEach(livePartials, id: \.runId) { partial in
                            AgentPartialView(
                                partial: partial,
                                author: partialAuthor(for: partial),
                                status: viewModel.agentStatuses[partial.runId]
                            )
                            .padding(.top, 8)
                        }

                        ForEach(viewModel.visibleWorkingAgents) { agent in
                            AgentWorkingTimelineRow(agent: agent, copy: copy)
                                .padding(.top, 8)
                                .id("working-\(agent.id.description)")
                        }

                        timelineBottomSentinel
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .coordinateSpace(name: TimelineCoordinateSpace.name)
                .onPreferenceChange(TimelineBottomPreferenceKey.self) { bottom in
                    isPinnedToTimelineBottom = bottom <= viewport.size.height + 32
                }
                .onChange(of: viewModel.selectedChannelId) { _, _ in
                    isPinnedToTimelineBottom = true
                    scrollToTimelineBottom(proxy)
                }
                .onChange(of: viewModel.visibleMessages.last?.id) { _, _ in
                    let forceForOwnSend = viewModel.visibleMessages.last.map(
                        viewModel.isCurrentMemberMessage
                    ) ?? false
                    followNewTimelineContentIfNeeded(proxy, force: forceForOwnSend)
                }
                .onChange(of: livePartials) { _, _ in
                    followNewTimelineContentIfNeeded(proxy)
                }
                .onChange(of: viewModel.visibleWorkRuns) { _, _ in
                    followNewTimelineContentIfNeeded(proxy)
                }
                .onChange(of: viewModel.visibleWorkingAgents.map(\.id)) { _, _ in
                    followNewTimelineContentIfNeeded(proxy)
                }
            }
        }
    }

    private func messageTimelineItem(
        _ item: MessageTimelineItem,
        copy: MomoWorkspaceCopy
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if item.startsDay, let day = item.day {
                TimelineDayDivider(day: day)
            }

            MessageBubble(
                message: item.message,
                author: viewModel.member(item.message.authorMemberId),
                cost: costSnapshot(for: item.message),
                approvalStatus: viewModel.approvalStatus(for: item.message),
                isApprovalDecisionInFlight: viewModel.isApprovalDecisionInFlight(for: item.message),
                onApprovalDecision: { approvalId, approve in
                    Task { await viewModel.decideApproval(approvalId, approve: approve) }
                },
                groupingStyle: item.startsGroup ? .groupStart : .compact,
                timelineCopy: copy
            )
            .padding(.top, item.startsGroup ? 8 : 0)
        }
        .id(item.id)
        .onAppear {
            viewModel.messageDidRender(item.message)
        }
    }

    private func workTimelineItem(
        _ run: AgentWorkRun,
        day: Date?,
        startsDay: Bool,
        copy: MomoWorkspaceCopy
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if startsDay, let day {
                TimelineDayDivider(day: day)
            }

            AgentWorkRunCard(
                run: run,
                agent: viewModel.member(run.agentMemberId),
                status: viewModel.effectiveWorkStatus(for: run),
                partial: viewModel.partials[run.id],
                approval: viewModel.workApproval(for: run.id),
                messages: viewModel.workMessages(for: run.id),
                isApprovalInFlight: viewModel.workApproval(for: run.id).map {
                    viewModel.approvalDecisionsInFlight.contains($0.approvalId)
                } ?? false,
                copy: copy,
                onApprovalDecision: { approvalId, approve in
                    Task { await viewModel.decideApproval(approvalId, approve: approve) }
                },
                onOpenDetail: {
                    onOpenWorkDetail(run.id)
                }
            )
            .padding(.top, 8)
        }
        .id("work-\(run.id.description)")
    }

    private var timelineBottomSentinel: some View {
        Color.clear
            .frame(height: 4)
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(
                        key: TimelineBottomPreferenceKey.self,
                        value: geometry.frame(in: .named(TimelineCoordinateSpace.name)).maxY
                    )
                }
            }
            .id(TimelineCoordinateSpace.bottomID)
    }

    private func followNewTimelineContentIfNeeded(
        _ proxy: ScrollViewProxy,
        force: Bool = false
    ) {
        guard MessageTimelineScrollPolicy.shouldFollowNewContent(
            wasAtBottom: isPinnedToTimelineBottom,
            isOwnSend: force
        ) else {
            return
        }
        scrollToTimelineBottom(proxy)
    }

    private func scrollToTimelineBottom(_ proxy: ScrollViewProxy) {
        if reduceMotion {
            proxy.scrollTo(TimelineCoordinateSpace.bottomID, anchor: .bottom)
        } else {
            withAnimation(.snappy) {
                proxy.scrollTo(TimelineCoordinateSpace.bottomID, anchor: .bottom)
            }
        }
    }

    // MARK: Composer (optimistic send)

    private func composer(copy: MomoWorkspaceCopy) -> some View {
        let candidates = viewModel.mentionAutocompleteCandidates()
        return VStack(alignment: .leading, spacing: 8) {
            if !candidates.isEmpty {
                mentionAutocomplete(candidates: Array(candidates.prefix(6)), copy: copy)
            }

            if !viewModel.visibleTypingMembers.isEmpty {
                typingIndicator(copy: copy)
            }

            HStack(spacing: 8) {
                Button {
                    presentWorkComposer()
                } label: {
                    Label(copy.startWork, systemImage: "hammer")
                        .labelStyle(.iconOnly)
                }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .disabled(viewModel.selectedChannelId == nil)
                .help("\(copy.startWork)  ⇧⌘W")
                .accessibilityLabel(copy.startWork)
                .popover(isPresented: $isWorkComposerPresented, arrowEdge: .bottom) {
                    AgentWorkComposerView(
                        viewModel: viewModel,
                        copy: copy,
                        initialBrief: initialWorkBrief,
                        onStarted: { _ in
                            initialWorkBrief = ""
                            workCommandDraftToRestore = nil
                            isWorkComposerPresented = false
                        },
                        onCancel: {
                            if let draft = workCommandDraftToRestore {
                                viewModel.composerDraft = draft
                                viewModel.composerDraftDidChange(draft)
                                isComposerFocused = true
                            }
                            initialWorkBrief = ""
                            workCommandDraftToRestore = nil
                            isWorkComposerPresented = false
                        }
                    )
                    .id(workComposerSessionId)
                }

                TextField(copy.messagePlaceholder, text: $viewModel.composerDraft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)
                    .font(.body)
                    .focused($isComposerFocused)
                    .onSubmit(submit)
                    .onChange(of: viewModel.composerDraft) { _, draft in
                        viewModel.composerDraftDidChange(draft)
                    }
                Button(action: submit) {
                    Image(systemName: "paperplane.fill")
                }
                .disabled(viewModel.composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || viewModel.selectedChannelId == nil)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private func typingIndicator(copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "ellipsis.bubble.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(MomoTheme.humanAccent)
            Text(copy.typingIndicator(viewModel.visibleTypingMembers.map(\.displayName)))
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(MomoTheme.humanAccent.opacity(0.08), in: Capsule())
        .fixedSize(horizontal: false, vertical: true)
    }

    private func mentionAutocomplete(candidates: [Member], copy: MomoWorkspaceCopy) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(copy.mentionAutocompleteTitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
            ForEach(candidates) { member in
                Button {
                    viewModel.completeMentionAutocomplete(with: member)
                } label: {
                    HStack(spacing: 12) {
                        MentionCandidateAvatar(member: member, isWorking: viewModel.isAgentWorking(member))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member.displayName)
                                .font(.callout.weight(.semibold))
                            HStack(spacing: MomoTheme.AgentBadge.spacing) {
                                Text("@\(member.handle) · \(member.isAgent ? copy.agent : copy.human)")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if member.isAgent {
                                    MomoAgentBadgeGroup(
                                        capabilities: member.normalizedCapabilities,
                                        maximumCapabilities: 1
                                    )
                                }
                            }
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .frame(width: MomoTheme.mentionAutocompleteWidth, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
    }

    private var preferredAgent: Member? {
        viewModel.members.first { $0.isAgent && viewModel.canInsertMention(for: $0) }
    }

    private func insertPreferredAgentMention() {
        guard let agent = preferredAgent else { return }
        viewModel.insertMention(for: agent)
    }

    private func submit() {
        guard let channel = viewModel.selectedChannelId else { return }
        let body = viewModel.composerDraft
        if let command = AgentWorkCommandParser.parse(body) {
            initialWorkBrief = command.brief
            workCommandDraftToRestore = command.draftToRestore
            workComposerSessionId = UUID()
            viewModel.clearWorkCreationError()
            viewModel.composerDraft = ""
            viewModel.composerDraftDidChange("")
            isWorkComposerPresented = true
            return
        }
        viewModel.composerDraft = ""
        Task { await viewModel.send(body: body, to: channel) }
    }

    private func presentWorkComposer() {
        initialWorkBrief = ""
        workCommandDraftToRestore = nil
        workComposerSessionId = UUID()
        viewModel.clearWorkCreationError()
        isWorkComposerPresented = true
    }

    // MARK: Derived

    /// Partials whose channel matches the selected channel.
    private var livePartials: [AgentPartial] {
        guard let id = viewModel.selectedChannelId else { return [] }
        let workRunIds = Set(viewModel.visibleWorkRuns.map(\.id))
        return viewModel.partials.values
            .filter { $0.channelId == id && !workRunIds.contains($0.runId) }
            .sorted { $0.runId.description < $1.runId.description }
    }

    /// Read the server-owned CostSnapshot projection for the message's run.
    private func costSnapshot(for message: Message) -> CostSnapshot? {
        guard let runId = message.runId else { return nil }
        return viewModel.costSnapshot(for: runId)
    }

    private func partialAuthor(for partial: AgentPartial) -> Member? {
        guard let agent = viewModel.agentStatuses[partial.runId]?.agentMemberId else {
            return nil
        }
        return viewModel.member(agent)
    }
}

private enum TimelineCoordinateSpace {
    static let name = "momo-message-timeline"
    static let bottomID = "timeline-bottom"
}

private struct TimelineBottomPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = .greatestFiniteMagnitude

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct TimelineDayDivider: View {
    let day: Date

    var body: some View {
        HStack(spacing: 8) {
            // Divider adopts vertical orientation inside HStack; a 1pt semantic rule keeps the day separator horizontal.
            Color.secondary.opacity(0.20)
                .frame(height: 1)
            Text(day, format: .dateTime.weekday(.wide).month().day())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .fixedSize()
            Color.secondary.opacity(0.20)
                .frame(height: 1)
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }
}

private struct TimelineEmptyState: View {
    let copy: MomoWorkspaceCopy
    let focusComposer: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Text(copy.timelineEmptyTitle)
                .font(.body.weight(.semibold))
            Button(copy.timelineEmptyAction, action: focusComposer)
                .buttonStyle(.link)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }
}

private struct TimelineLoadingState: View {
    let copy: MomoWorkspaceCopy

    var body: some View {
        Label(copy.timelineLoading, systemImage: "clock")
            .font(.body)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
    }
}

private struct MomoGuideStepPill: View {
    var index: Int
    var title: String

    var body: some View {
        HStack(spacing: 4) {
            Text("\(index)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(MomoTheme.onAccent)
                .frame(width: 16, height: 16)
                .background(MomoTheme.humanAccent, in: Circle())
            Text(title)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.thinMaterial, in: Capsule())
    }
}

private struct AgentWorkingTimelineRow: View {
    var agent: Member
    var copy: MomoWorkspaceCopy

    var body: some View {
        HStack(spacing: 12) {
            ProgressView()
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 4) {
                Text(copy.agentWorkingTitle(agent.displayName))
                    .font(.callout.weight(.semibold))
                Text(copy.agentWorkingSubtitle)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(MomoTheme.agentAccent.opacity(0.09), in: RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.bubbleCorner, style: .continuous)
                .stroke(MomoTheme.agentAccent.opacity(0.16), lineWidth: 1)
        }
    }
}

private struct MentionCandidateAvatar: View {
    var member: Member
    var isWorking: Bool

    private var initials: String {
        guard let first = member.displayName.trimmingCharacters(in: .whitespacesAndNewlines).first else {
            return member.isAgent ? "A" : "M"
        }
        return String(first).uppercased()
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Text(initials)
                .font(.caption.weight(.bold))
                .foregroundStyle(MomoTheme.onAccent)
                .frame(width: MomoTheme.messageAvatarSize, height: MomoTheme.messageAvatarSize)
                .background(member.isAgent ? MomoTheme.agentAccent : MomoTheme.humanAccent, in: Circle())
            Circle()
                .fill(isWorking ? MomoTheme.costAmber : .secondary)
                .frame(width: 8, height: 8)
                .overlay(Circle().stroke(MomoTheme.subtleBorder, lineWidth: 1))
        }
    }
}
