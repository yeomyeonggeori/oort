import AppKit
import SwiftUI
import MomoCore

enum MomoMentionSelection {
    static func moved(
        current: MemberID?,
        candidates: [MemberID],
        offset: Int
    ) -> MemberID? {
        guard !candidates.isEmpty else { return nil }
        guard let currentIndex = current.flatMap(candidates.firstIndex(of:)) else {
            return offset < 0 ? candidates.last : candidates.first
        }
        let nextIndex = (currentIndex + offset + candidates.count) % candidates.count
        return candidates[nextIndex]
    }
}

private struct MomoMentionPanelHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - MessageListView  (seq-ordered)
//
// The channel timeline. Ordering authority is Message.seq (L4 §1.2 #3): the
// ViewModel keeps messages seq-sorted, this view just renders them oldest→newest
// and pins live agent partials at the bottom (AgentPartialView). Includes a small
// composer wired to optimistic send.

public struct MessageListView: View {
    @ObservedObject var viewModel: ChatViewModel
    private let onOpenWorkDetail: (RunID) -> Void
    private let onRequestLogin: () -> Void
    private let onOpenMemberDirectory: MomoMemberDirectoryHook?
    private let focusComposerRequest: UInt64
    private let onChannelHeaderHeightChange: (CGFloat) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage("momo.workspace.showQuickStart") private var showQuickStart = true
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @AppStorage(MomoDeveloperModePresentation.costDisplayKey) private var showCosts = false
    @FocusState private var isComposerFocused: Bool
    @State private var isPinnedToTimelineBottom = true
    @State private var isWorkComposerPresented = false
    @State private var initialWorkBrief = ""
    @State private var workCommandDraftToRestore: String?
    @State private var workComposerSessionId = UUID()
    @State private var channelPresentationRevision = 0
    @State private var selectedMentionCandidateID: MemberID?
    @State private var hoveredMentionCandidateID: MemberID?
    @State private var measuredMentionPanelHeight: CGFloat = 0
    @State private var suppressedMentionDraft: String?
    @State private var isActionLauncherPresented = false
    @State private var localDraftSheet: MomoComposerDraftSheet?
    @State private var attachmentDrafts: [MomoAttachmentDraft] = []
    @State private var isFileDropTargeted = false
    @State private var threadTopic = ""
    @State private var pollQuestion = ""
    @State private var pollOptions = ["", ""]
    @State private var selectedPlugins: Set<String> = []

    public init(
        viewModel: ChatViewModel,
        onOpenWorkDetail: @escaping (RunID) -> Void = { _ in },
        onRequestLogin: @escaping () -> Void = {},
        onOpenMemberDirectory: MomoMemberDirectoryHook? = nil,
        focusComposerRequest: UInt64 = 0
    ) {
        self.viewModel = viewModel
        self.onOpenWorkDetail = onOpenWorkDetail
        self.onRequestLogin = onRequestLogin
        self.onOpenMemberDirectory = onOpenMemberDirectory
        self.focusComposerRequest = focusComposerRequest
        self.onChannelHeaderHeightChange = { _ in }
    }

    init(
        viewModel: ChatViewModel,
        onOpenWorkDetail: @escaping (RunID) -> Void,
        onRequestLogin: @escaping () -> Void,
        onOpenMemberDirectory: MomoMemberDirectoryHook?,
        focusComposerRequest: UInt64 = 0,
        onChannelHeaderHeightChange: @escaping (CGFloat) -> Void
    ) {
        self.viewModel = viewModel
        self.onOpenWorkDetail = onOpenWorkDetail
        self.onRequestLogin = onRequestLogin
        self.onOpenMemberDirectory = onOpenMemberDirectory
        self.focusComposerRequest = focusComposerRequest
        self.onChannelHeaderHeightChange = onChannelHeaderHeightChange
    }

    public var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        VStack(spacing: 0) {
            header(copy: copy)
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(
                            key: MomoChannelHeaderHeightPreferenceKey.self,
                            value: geometry.size.height
                        )
                    }
                }
            if showQuickStart {
                quickStartCard(copy: copy)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
            if let issue = viewModel.connectionIssue {
                connectionBanner(issue, copy: copy)
                Divider()
            }
            if let notice = viewModel.mentionNotice {
                mentionNoticeBanner(notice)
                Divider()
            }
            timeline(copy: copy)
            Divider()
            composer(copy: copy)
        }
        .momoSurface(.background, cornerRadius: 0, extent: .windowChrome)
        .onPreferenceChange(MomoChannelHeaderHeightPreferenceKey.self) { height in
            onChannelHeaderHeightChange(height)
        }
        .onChange(of: focusComposerRequest) { _, _ in
            isComposerFocused = true
        }
        .onChange(of: viewModel.selectedChannelId) { _, _ in
            resetLocalComposerDraftsForChannelChange()
        }
        .onReceive(NotificationCenter.default.publisher(for: MomoLocalChannelPresentationStore.didChangeNotification)) { _ in
            channelPresentationRevision &+= 1
        }
        .dropDestination(for: URL.self) { urls, _ in
            addAttachmentDrafts(urls)
            return urls.contains(where: \.isFileURL)
        } isTargeted: { isTargeted in
            isFileDropTargeted = isTargeted
        }
        .overlay {
            if isFileDropTargeted {
                MomoFileDropOverlay(copy: MomoComposerActionCopy(language: language))
            }
        }
        .sheet(item: $localDraftSheet) { sheet in
            MomoLocalDraftSheet(
                sheet: sheet,
                copy: MomoComposerActionCopy(language: language),
                threadTopic: $threadTopic,
                pollQuestion: $pollQuestion,
                pollOptions: $pollOptions,
                selectedPlugins: $selectedPlugins
            )
        }
    }

    // MARK: Channel header

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func header(copy: MomoWorkspaceCopy) -> some View {
        Group {
            if let channel = viewModel.selectedChannel {
                MomoChannelHeaderView(
                    channel: channel,
                    presentation: channelPresentation(for: channel),
                    memberCount: viewModel.activeMembers(in: channel.id).count,
                    realtimeStatus: viewModel.selectedRealtimeStatus,
                    spentMicroUSD: viewModel.liveSpentMicroUSD,
                    showsCosts: presentation.showsCosts,
                    copy: copy,
                    retryRealtime: viewModel.selectedRealtimeStatus?.canRetry == true ? {
                        Task { await viewModel.retryRealtime() }
                    } : nil,
                    openMemberDirectory: onOpenMemberDirectory
                )
            } else {
                Text(copy.selectChannel)
                    .font(MomoTheme.Typography.row)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: MomoTheme.ChannelHeader.minimumHeight)
                    .momoSurface(.panel, cornerRadius: 0)
            }
        }
    }

    private func channelPresentation(for channel: Channel) -> MomoChannelPresentation {
        _ = channelPresentationRevision
        return MomoLocalChannelPresentationStore.presentation(for: channel)
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
                    .font(MomoTheme.Typography.emphasizedRow)
                Text(copy.quickStartSubtitle)
                    .font(MomoTheme.Typography.supporting)
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
        .momoSurface(.card)
    }

    private func connectionBanner(_ issue: MomoConnectionIssue, copy: MomoWorkspaceCopy) -> some View {
        let tint = connectionBannerTint(issue)
        return HStack(spacing: 8) {
            Image(systemName: connectionBannerIcon(issue))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 4) {
                Text(connectionBannerTitle(issue, copy: copy))
                    .font(MomoTheme.Typography.sectionHeader)
                Text(connectionBannerDetail(issue, copy: copy))
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            switch issue {
            case .authenticationExpired:
                Button(copy.signInAgain) {
                    viewModel.clearConnectionError()
                    onRequestLogin()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            case .loadFailed:
                Button {
                    Task { await viewModel.retrySelectedChannelLoad() }
                } label: {
                    Label(copy.retry, systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button {
                    viewModel.clearConnectionError()
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .help(copy.dismiss)
            case .sendFailed:
                Button(copy.sendAgain) {
                    Task { await viewModel.retryFailedSend() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                Button {
                    viewModel.clearConnectionError()
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .help(copy.dismiss)
            case .actionFailed:
                Button(copy.dismiss) {
                    viewModel.clearConnectionError()
                }
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(tint.opacity(0.06))
        .momoSurface(.panel, cornerRadius: 0)
    }

    private func connectionBannerIcon(_ issue: MomoConnectionIssue) -> String {
        switch issue {
        case .authenticationExpired: return "person.crop.circle.badge.exclamationmark"
        case .loadFailed: return "wifi.exclamationmark"
        case .sendFailed: return "paperplane.fill"
        case .actionFailed: return "exclamationmark.triangle"
        }
    }

    private func connectionBannerTint(_ issue: MomoConnectionIssue) -> Color {
        switch issue {
        case .authenticationExpired, .sendFailed:
            return MomoTheme.irreversibleRed
        case .loadFailed, .actionFailed:
            return MomoTheme.costAmber
        }
    }

    private func connectionBannerTitle(_ issue: MomoConnectionIssue, copy: MomoWorkspaceCopy) -> String {
        switch issue {
        case .authenticationExpired:
            return copy.sessionExpiredTitle
        case .loadFailed:
            return copy.messageLoadFailedTitle
        case .sendFailed:
            if let agentName = viewModel.failedMentionedAgentName {
                return copy.agentCallSendFailedTitle(agentName)
            }
            return copy.messageSendFailedTitle
        case .actionFailed:
            return copy.actionFailedTitle
        }
    }

    private func connectionBannerDetail(_ issue: MomoConnectionIssue, copy: MomoWorkspaceCopy) -> String {
        switch issue {
        case .authenticationExpired:
            return copy.sessionExpiredDetail
        case .loadFailed:
            return copy.messageLoadFailedDetail
        case .sendFailed:
            return viewModel.failedMentionedAgentName == nil
                ? copy.messageSendFailedDetail
                : copy.agentCallSendFailedDetail
        case .actionFailed:
            return copy.actionFailedDetail
        }
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
                                status: viewModel.agentStatuses[partial.runId],
                                presentation: presentation,
                                copy: copy
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
                TimelineDayDivider(day: day, copy: copy)
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
                timelineCopy: copy,
                presentation: presentation
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
                TimelineDayDivider(day: day, copy: copy)
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
                presentation: presentation,
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
            withAnimation(MomoTheme.Motion.stateChange) {
                proxy.scrollTo(TimelineCoordinateSpace.bottomID, anchor: .bottom)
            }
        }
    }

    // MARK: Composer (optimistic send)

    private func composer(copy: MomoWorkspaceCopy) -> some View {
        let candidates = suppressedMentionDraft == viewModel.composerDraft
            ? []
            : Array(viewModel.mentionAutocompleteCandidates().prefix(MomoTheme.mentionAutocompleteMaximumRows))
        return VStack(alignment: .leading, spacing: 8) {
            if !viewModel.visibleTypingMembers.isEmpty {
                typingIndicator(copy: copy)
            }

            if !attachmentDrafts.isEmpty {
                MomoAttachmentDraftStrip(
                    drafts: attachmentDrafts,
                    copy: MomoComposerActionCopy(language: language),
                    onRemove: removeAttachmentDraft,
                    onClear: { attachmentDrafts.removeAll() }
                )
            }

            if hasLocalStructuredDrafts {
                localStructuredDraftSummary
            }

            composerSurface(candidates: candidates, copy: copy)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .zIndex(10)
        .onChange(of: candidates.map(\.id)) { _, candidateIDs in
            guard let selectedMentionCandidateID,
                  candidateIDs.contains(selectedMentionCandidateID) else {
                self.selectedMentionCandidateID = candidateIDs.first
                return
            }
        }
    }

    private func composerSurface(candidates: [Member], copy: MomoWorkspaceCopy) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            ZStack {
                Button {
                    isActionLauncherPresented.toggle()
                } label: {
                    Label(MomoComposerActionCopy(language: language).launcherTitle, systemImage: "plus")
                        .labelStyle(.iconOnly)
                        .font(.title3.weight(.medium))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .disabled(viewModel.selectedChannelId == nil)
                .help(MomoComposerActionCopy(language: language).launcherTitle)
                .accessibilityLabel(MomoComposerActionCopy(language: language).launcherTitle)
                .popover(isPresented: $isActionLauncherPresented, arrowEdge: .bottom) {
                    MomoComposerActionLauncher(copy: MomoComposerActionCopy(language: language)) { action in
                        isActionLauncherPresented = false
                        handleComposerAction(action)
                    }
                }

                Color.clear
                    .frame(width: 1, height: 1)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .popover(isPresented: $isWorkComposerPresented, arrowEdge: .bottom) {
                        workComposerPopover(copy: copy)
                    }
            }

            Button(action: presentWorkComposer) { EmptyView() }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .frame(width: 0, height: 0)
                .opacity(0)
                .disabled(viewModel.selectedChannelId == nil)
                .allowsHitTesting(false)
                .accessibilityHidden(true)

            TextField(copy.messagePlaceholder, text: $viewModel.composerDraft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .font(.body)
                .padding(.vertical, 12)
                .focused($isComposerFocused)
                .accessibilityIdentifier("momo-message-composer")
                .onSubmit {
                    if candidates.isEmpty {
                        submit()
                    } else {
                        completeSelectedMention(from: candidates)
                    }
                }
                .onKeyPress(.upArrow) {
                    moveMentionSelection(in: candidates, offset: -1)
                }
                .onKeyPress(.downArrow) {
                    moveMentionSelection(in: candidates, offset: 1)
                }
                .onKeyPress(.tab) {
                    guard !candidates.isEmpty else { return .ignored }
                    completeSelectedMention(from: candidates)
                    return .handled
                }
                .onKeyPress(.escape) {
                    guard !candidates.isEmpty else { return .ignored }
                    suppressedMentionDraft = viewModel.composerDraft
                    selectedMentionCandidateID = nil
                    return .handled
                }
                .onChange(of: viewModel.composerDraft) { _, draft in
                    if draft != suppressedMentionDraft {
                        suppressedMentionDraft = nil
                    }
                    viewModel.composerDraftDidChange(draft)
                }

            Button(action: submit) {
                Label(copy.sendMessage, systemImage: "paperplane.fill")
                    .labelStyle(.iconOnly)
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
            .foregroundStyle(canSendMessage ? MomoTheme.humanAccent : Color.secondary)
            .disabled(!canSendMessage)
            .accessibilityLabel(copy.sendMessage)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: MomoTheme.composerMinimumHeight)
        // A timeline composer needs one continuous surface; the native rounded
        // TextField draws a second focus ring and visually nests the control.
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(
            cornerRadius: MomoTheme.cornerMedium,
            style: .continuous
        ))
        .overlay {
            RoundedRectangle(cornerRadius: MomoTheme.cornerMedium, style: .continuous)
                .stroke(MomoTheme.subtleBorder, lineWidth: 1)
        }
        // The system popover does not expose row-level keyboard selection state,
        // so this window-local overlay keeps the candidate list anchored without
        // changing the timeline layout.
        .overlay(alignment: .topLeading) {
            if !candidates.isEmpty {
                mentionAutocomplete(candidates: candidates, copy: copy)
                    .background {
                        GeometryReader { geometry in
                            Color.clear.preference(
                                key: MomoMentionPanelHeightPreferenceKey.self,
                                value: geometry.size.height
                            )
                        }
                    }
                    // The first layout pass measures intrinsic localized row
                    // height. Only then reveal the panel at the exact 8pt gap.
                    .opacity(measuredMentionPanelHeight > 0 ? 1 : 0)
                    .offset(y: -measuredMentionPanelHeight - 8)
            }
        }
        .onPreferenceChange(MomoMentionPanelHeightPreferenceKey.self) { height in
            measuredMentionPanelHeight = height
        }
    }

    private func workComposerPopover(copy: MomoWorkspaceCopy) -> some View {
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

    private func handleComposerAction(_ action: MomoComposerAction) {
        switch action {
        case .fileUpload:
            chooseAttachmentFiles()
        case .startWork:
            Task { @MainActor in
                await Task.yield()
                presentWorkComposer()
            }
        case .createThread:
            localDraftSheet = .thread
        case .createPoll:
            localDraftSheet = .poll
        case .addPlugin:
            localDraftSheet = .plugins
        }
    }

    private func chooseAttachmentFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.begin { response in
            guard response == .OK else { return }
            addAttachmentDrafts(panel.urls)
        }
    }

    private func addAttachmentDrafts(_ urls: [URL]) {
        attachmentDrafts = MomoAttachmentDraftCollection.merging(attachmentDrafts, urls: urls)
    }

    private func removeAttachmentDraft(_ draft: MomoAttachmentDraft) {
        attachmentDrafts.removeAll { $0.id == draft.id }
    }

    private var hasLocalStructuredDrafts: Bool {
        !threadTopic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pollQuestion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || pollOptions.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            || !selectedPlugins.isEmpty
    }

    private var localStructuredDraftSummary: some View {
        let copy = MomoComposerActionCopy(language: language)
        return VStack(alignment: .leading, spacing: MomoTheme.ComposerAction.standardSpacing) {
            Label(copy.draftSummaryTitle, systemImage: "square.and.pencil")
                .font(MomoTheme.Typography.supporting.weight(.medium))
            HStack(spacing: MomoTheme.ComposerAction.standardSpacing) {
                if !threadTopic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        localDraftSheet = .thread
                    } label: {
                        Label(copy.threadDraftLabel, systemImage: MomoComposerAction.createThread.systemImage)
                    }
                }
                if !pollQuestion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || pollOptions.contains(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                    Button {
                        localDraftSheet = .poll
                    } label: {
                        Label(copy.pollDraftLabel, systemImage: MomoComposerAction.createPoll.systemImage)
                    }
                }
                if !selectedPlugins.isEmpty {
                    Button {
                        localDraftSheet = .plugins
                    } label: {
                        Label("\(copy.pluginDraftLabel) \(selectedPlugins.count)", systemImage: MomoComposerAction.addPlugin.systemImage)
                    }
                }
                Spacer(minLength: 0)
            }
            .buttonStyle(.bordered)
            Label(copy.connectionPending, systemImage: "info.circle")
                .font(MomoTheme.Typography.metadata)
                .foregroundStyle(.secondary)
        }
        .padding(MomoTheme.ComposerAction.contentSpacing)
        .momoSurface(.panel, cornerRadius: MomoTheme.cornerMedium)
    }

    private func resetLocalComposerDraftsForChannelChange() {
        isActionLauncherPresented = false
        isWorkComposerPresented = false
        localDraftSheet = nil
        attachmentDrafts.removeAll()
        threadTopic = ""
        pollQuestion = ""
        pollOptions = ["", ""]
        selectedPlugins.removeAll()
    }

    private var canSendMessage: Bool {
        !viewModel.composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && viewModel.selectedChannelId != nil
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
                .font(MomoTheme.Typography.supporting.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
            ForEach(Array(candidates.enumerated()), id: \.element.id) { index, member in
                let isSelected = member.id == selectedMentionCandidateID
                let isHovered = member.id == hoveredMentionCandidateID
                Button {
                    completeMention(with: member)
                } label: {
                    HStack(spacing: 12) {
                        MentionCandidateAvatar(member: member, isWorking: viewModel.isAgentWorking(member))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(member.displayName)
                                .font(MomoTheme.Typography.emphasizedRow)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                                .layoutPriority(1)
                            HStack(spacing: MomoTheme.AgentBadge.spacing) {
                                Text(member.isAgent ? "@\(member.handle)" : "@\(member.handle) · \(copy.human)")
                                    .font(MomoTheme.Typography.supporting)
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
                    .background(
                        isSelected
                            ? MomoTheme.QuickSwitcher.selectionBackground
                            : (isHovered ? MomoTheme.QuickSwitcher.hoverBackground : Color.clear),
                        in: RoundedRectangle(
                            cornerRadius: MomoTheme.QuickSwitcher.rowCornerRadius,
                            style: .continuous
                        )
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    "\(member.displayName), @\(member.handle), \(member.isAgent ? copy.agent : copy.human)"
                )
                .accessibilityValue(
                    copy.mentionAutocompletePosition(
                        index: index + 1,
                        total: candidates.count,
                        isSelected: isSelected
                    )
                )
                .accessibilityAddTraits(isSelected ? .isSelected : [])
                .onHover { hovering in
                    hoveredMentionCandidateID = hovering ? member.id : nil
                }
            }
        }
        .padding(8)
        .frame(width: MomoTheme.mentionAutocompleteWidth, alignment: .leading)
        .momoSurface(.card)
    }

    private func moveMentionSelection(in candidates: [Member], offset: Int) -> KeyPress.Result {
        guard !candidates.isEmpty else { return .ignored }
        selectedMentionCandidateID = MomoMentionSelection.moved(
            current: selectedMentionCandidateID,
            candidates: candidates.map(\.id),
            offset: offset
        )
        return .handled
    }

    private func completeSelectedMention(from candidates: [Member]) {
        let selected = selectedMentionCandidateID
            .flatMap { id in candidates.first { $0.id == id } }
            ?? candidates.first
        guard let selected else { return }
        completeMention(with: selected)
    }

    private func completeMention(with member: Member) {
        viewModel.completeMentionAutocomplete(with: member)
        selectedMentionCandidateID = nil
        suppressedMentionDraft = nil
        isComposerFocused = true
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
        guard presentation.showsCosts else { return nil }
        guard let runId = message.runId else { return nil }
        return viewModel.costSnapshot(for: runId)
    }

    private var presentation: MomoDeveloperModePresentation {
        MomoDeveloperModePresentation(
            isDeveloperModeEnabled: developerMode,
            isCostDisplayEnabled: showCosts
        )
    }

    private func partialAuthor(for partial: AgentPartial) -> Member? {
        guard let agent = viewModel.agentStatuses[partial.runId]?.agentMemberId else {
            return nil
        }
        return viewModel.member(agent)
    }
}

private struct MomoChannelHeaderHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
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
    let copy: MomoWorkspaceCopy

    var body: some View {
        HStack(spacing: 8) {
            // Divider adopts vertical orientation inside HStack; a 1pt semantic rule keeps the day separator horizontal.
            Color.secondary.opacity(0.20)
                .frame(height: 1)
            Text(copy.timelineDay(day))
                .font(MomoTheme.Typography.supporting.weight(.semibold))
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
