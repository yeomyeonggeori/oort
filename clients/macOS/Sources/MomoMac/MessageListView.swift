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

private struct MomoMessageListWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private enum MomoChannelMenuFocusTarget: Hashable {
    case settings
    case invite
    case members
    case copyID
    case leave
}

private struct MomoServedContextSelection: Identifiable {
    let id: UUID
}

// MARK: - MessageListView  (seq-ordered)
//
// The channel timeline. Ordering authority is Message.seq (L4 §1.2 #3): the
// ViewModel keeps messages seq-sorted, this view just renders them oldest→newest
// and pins live agent partials at the bottom (AgentPartialView). Includes a small
// composer wired to optimistic send.

public struct MessageListView: View {
    @ObservedObject var viewModel: ChatViewModel
    @StateObject private var huddleViewModel: MomoHuddleViewModel
    private let onOpenWorkDetail: (RunID) -> Void
    private let canOpenWorkTerminal: (WorkSessionID) -> Bool
    private let onOpenWorkTerminal: (WorkSessionID) -> Void
    private let onOpenWorkSession: (WorkSessionID) -> Void
    private let onRequestLogin: () -> Void
    private let onOpenMemberDirectory: MomoMemberDirectoryHook?
    private let onOpenChannelSettings: ((ChannelID) -> Void)?
    private let onInviteToChannel: ((ChannelID) -> Void)?
    private let onCreateAgent: ((ChannelID) -> Void)?
    private let focusComposerRequest: UInt64
    private let onOpenPluginMarketplace: () -> Void
    private let serverIdentity: String?
    private let sidebarToggle: (() -> Void)?
    private let dismissThreadRequest: UInt64
    private let onPresentThread: () -> Void
    private let onDismissThread: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.momoCenterHeaderLeadingInset) private var centerHeaderLeadingInset
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage("momo.workspace.showQuickStart") private var showQuickStart = true
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @AppStorage(MomoDeveloperModePresentation.costDisplayKey) private var showCosts = false
    @State private var isComposerFocused = false
    @FocusState private var channelMenuKeyboardFocus: MomoChannelMenuFocusTarget?
    @AccessibilityFocusState private var accessibilityFocusedMessageID: MessageID?
    @AccessibilityFocusState private var channelMenuAccessibilityFocus: MomoChannelMenuFocusTarget?
    @State private var isPinnedToTimelineBottom = true
    @State private var isWorkComposerPresented = false
    @State private var initialWorkBrief = ""
    @State private var workCommandDraftToRestore: String?
    @State private var workComposerSessionId = UUID()
    @State private var channelPresentationRevision = 0
    @State private var selectedMentionCandidateID: MemberID?
    @State private var hoveredMentionCandidateID: MemberID?
    @State private var measuredMentionPanelHeight: CGFloat = 0
    @State private var composerEditorHeight = MomoTheme.composerMinimumHeight
    @State private var suppressedMentionDraft: String?
    @State private var isActionLauncherPresented = false
    @State private var localDraftSheet: MomoComposerDraftSheet?
    @State private var attachmentDraftsByChannel: [ChannelID: [MomoAttachmentDraft]] = [:]
    @State private var isSendingComposerMessage = false
    @State private var selectedPlugins: Set<String> = []
    @State private var isFileDropTargeted = false
    @State private var threadTopic = ""
    @State private var pollQuestion = ""
    @State private var pollOptions = ["", ""]
    @State private var highlightedMessageID: MessageID?
    @State private var isChannelMenuPresented = false
    @State private var channelLeaveConfirmation: Channel?
    @State private var channelLeaveFailed = false
    @State private var selectedThreadRootID: MessageID?
    @State private var availableTimelineWidth: CGFloat = 0
    @State private var servedContextSelection: MomoServedContextSelection?

    public init(
        viewModel: ChatViewModel,
        onOpenWorkDetail: @escaping (RunID) -> Void = { _ in },
        canOpenWorkTerminal: @escaping (WorkSessionID) -> Bool = { _ in false },
        onOpenWorkTerminal: @escaping (WorkSessionID) -> Void = { _ in },
        onOpenWorkSession: @escaping (WorkSessionID) -> Void = { _ in },
        onRequestLogin: @escaping () -> Void = {},
        onOpenMemberDirectory: MomoMemberDirectoryHook? = nil,
        onOpenChannelSettings: ((ChannelID) -> Void)? = nil,
        onInviteToChannel: ((ChannelID) -> Void)? = nil,
        onCreateAgent: ((ChannelID) -> Void)? = nil,
        focusComposerRequest: UInt64 = 0,
        serverIdentity: String? = nil,
        sidebarToggle: (() -> Void)? = nil,
        dismissThreadRequest: UInt64 = 0
    ) {
        self.viewModel = viewModel
        self.onOpenWorkDetail = onOpenWorkDetail
        self.canOpenWorkTerminal = canOpenWorkTerminal
        self.onOpenWorkTerminal = onOpenWorkTerminal
        self.onOpenWorkSession = onOpenWorkSession
        self.onRequestLogin = onRequestLogin
        self.onOpenMemberDirectory = onOpenMemberDirectory
        self.onOpenChannelSettings = onOpenChannelSettings
        self.onInviteToChannel = onInviteToChannel
        self.onCreateAgent = onCreateAgent
        self.focusComposerRequest = focusComposerRequest
        self.serverIdentity = serverIdentity
        self.sidebarToggle = sidebarToggle
        self.dismissThreadRequest = dismissThreadRequest
        self.onPresentThread = {}
        self.onDismissThread = {}
        self.onOpenPluginMarketplace = {}
        _huddleViewModel = StateObject(wrappedValue: .live(serverIdentity: serverIdentity))
    }

    init(
        viewModel: ChatViewModel,
        onOpenWorkDetail: @escaping (RunID) -> Void,
        canOpenWorkTerminal: @escaping (WorkSessionID) -> Bool = { _ in false },
        onOpenWorkTerminal: @escaping (WorkSessionID) -> Void = { _ in },
        onOpenWorkSession: @escaping (WorkSessionID) -> Void = { _ in },
        onRequestLogin: @escaping () -> Void,
        onOpenMemberDirectory: MomoMemberDirectoryHook?,
        onOpenChannelSettings: ((ChannelID) -> Void)? = nil,
        onInviteToChannel: ((ChannelID) -> Void)? = nil,
        onCreateAgent: ((ChannelID) -> Void)? = nil,
        focusComposerRequest: UInt64 = 0,
        serverIdentity: String? = nil,
        sidebarToggle: (() -> Void)? = nil,
        dismissThreadRequest: UInt64 = 0,
        onPresentThread: @escaping () -> Void = {},
        onDismissThread: @escaping () -> Void = {},
        onOpenPluginMarketplace: @escaping () -> Void = {}
    ) {
        self.viewModel = viewModel
        self.onOpenWorkDetail = onOpenWorkDetail
        self.canOpenWorkTerminal = canOpenWorkTerminal
        self.onOpenWorkTerminal = onOpenWorkTerminal
        self.onOpenWorkSession = onOpenWorkSession
        self.onRequestLogin = onRequestLogin
        self.onOpenMemberDirectory = onOpenMemberDirectory
        self.onOpenChannelSettings = onOpenChannelSettings
        self.onInviteToChannel = onInviteToChannel
        self.onCreateAgent = onCreateAgent
        self.focusComposerRequest = focusComposerRequest
        self.serverIdentity = serverIdentity
        self.sidebarToggle = sidebarToggle
        self.dismissThreadRequest = dismissThreadRequest
        self.onPresentThread = onPresentThread
        self.onDismissThread = onDismissThread
        self.onOpenPluginMarketplace = onOpenPluginMarketplace
        _huddleViewModel = StateObject(wrappedValue: .live(serverIdentity: serverIdentity))
    }

    public var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                header(copy: copy)
                if showQuickStart {
                    quickStartCard(copy: copy)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 12)
                }
                if let issue = viewModel.connectionIssue {
                    connectionBanner(issue, copy: copy)
                    Divider()
                }
                if channelLeaveFailed {
                    channelLeaveFailureBanner(copy: copy)
                    Divider()
                }
                if viewModel.failedMessageFocus != nil {
                    HStack(spacing: 8) {
                        Label(copy.messageFocusFailedDetail, systemImage: "magnifyingglass")
                            .font(MomoTheme.Typography.supporting)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button(copy.dismissMessageFocusFailure) {
                            viewModel.clearFailedMessageFocus()
                        }
                        .controlSize(.small)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
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
            .accessibilityHidden(isChannelMenuPresented)

            if isChannelMenuPresented, let channel = viewModel.selectedChannel {
                Color.primary.opacity(0.001)
                    .onTapGesture {
                        isChannelMenuPresented = false
                    }
                    .zIndex(1)

                // A system Menu cannot provide the requested non-animated attached card.
                channelActionPanel(channel: channel, copy: copy)
                    .padding(.top, MomoWindowChromeLayout.integratedHeaderHeight + MomoTheme.ChannelHeader.standardSpacing)
                    .padding(.leading, channelMenuLeadingInset)
                    .transaction { transaction in
                        transaction.animation = nil
                        transaction.disablesAnimations = true
                    }
                    .zIndex(2)
            }
        }
        .momoSurface(.background, cornerRadius: 0, extent: .windowChrome)
        .background {
            GeometryReader { geometry in
                Color.clear.preference(
                    key: MomoMessageListWidthPreferenceKey.self,
                    value: geometry.size.width
                )
            }
        }
        .onPreferenceChange(MomoMessageListWidthPreferenceKey.self) {
            availableTimelineWidth = $0
        }
        .onChange(of: focusComposerRequest, initial: true) { _, request in
            guard request > 0 else { return }
            isComposerFocused = true
        }
        .onChange(of: viewModel.selectedChannelId) { _, _ in
            isChannelMenuPresented = false
            channelLeaveFailed = false
            if selectedThreadRootID != nil { onDismissThread() }
            selectedThreadRootID = nil
            resetLocalComposerDraftsForChannelChange()
            pruneAttachmentDrafts()
            loadSelectedPlugins()
        }
        .onChange(of: dismissThreadRequest) { _, _ in
            guard selectedThreadRootID != nil else { return }
            selectedThreadRootID = nil
            onDismissThread()
        }
        .onChange(of: viewModel.requestedThreadRootID) { _, rootID in
            guard let rootID else { return }
            selectedThreadRootID = rootID
            onPresentThread()
            viewModel.consumeRequestedThread(rootID)
        }
        .onReceive(NotificationCenter.default.publisher(for: MomoLocalChannelPresentationStore.didChangeNotification)) { _ in
            channelPresentationRevision &+= 1
        }
        .dropDestination(for: URL.self) { urls, _ in
            addAttachmentDrafts(urls) > 0
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
        .sheet(item: $servedContextSelection) { selection in
            MomoContextPacketInspectorView(
                viewModel: viewModel,
                packetID: selection.id,
                copy: copy
            )
        }
        .confirmationDialog(
            copy.leaveChannelQuestion,
            isPresented: Binding(
                get: { channelLeaveConfirmation != nil },
                set: { if !$0 { channelLeaveConfirmation = nil } }
            ),
            presenting: channelLeaveConfirmation
        ) { channel in
            Button(copy.leaveChannelAction(channelPresentation(for: channel).name), role: .destructive) {
                Task {
                    if await viewModel.leaveCurrentChannel() {
                        channelLeaveConfirmation = nil
                    } else {
                        channelLeaveFailed = true
                    }
                }
            }
            Button(copy.cancel, role: .cancel) {}
        } message: { channel in
            Text(copy.leaveChannelExplanation(channelPresentation(for: channel).name))
        }
        .onAppear(perform: loadSelectedPlugins)
        .onChange(of: selectedPlugins) { _, _ in saveSelectedPlugins() }
        .onChange(of: viewModel.workspaceId) { _, _ in loadSelectedPlugins() }
        .onChange(of: viewModel.currentNavigationMemberID) { _, _ in loadSelectedPlugins() }
        .task(id: huddleActivationID) {
            guard let channelID = viewModel.selectedChannelId else {
                await huddleViewModel.shutdown()
                return
            }
            await huddleViewModel.activate(workspace: viewModel.workspaceId, channel: channelID)
        }
        .onDisappear {
            Task { await huddleViewModel.shutdown() }
        }
        .safeAreaInset(edge: .trailing, spacing: 0) {
            if let threadRoot {
                MomoRightPanelBelowHeader {
                    MomoMessageThreadPanel(
                        viewModel: viewModel,
                        root: threadRoot,
                        copy: copy,
                        presentation: presentation,
                        onClose: {
                            selectedThreadRootID = nil
                            onDismissThread()
                        }
                    )
                }
                .frame(
                    width: MomoRightPanelLayout.width(
                        preferredWidth: MomoTheme.MessageInteraction.threadIdealWidth,
                        availableWidth: availableTimelineWidth
                    )
                )
                .transition(.identity)
            }
        }
    }

    // MARK: Channel header

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func channelLeaveFailureBanner(copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: MomoTheme.ChannelHeader.standardSpacing) {
            Label(copy.leaveChannelFailed, systemImage: "exclamationmark.triangle")
                .font(MomoTheme.Typography.supporting)
                .foregroundStyle(MomoTheme.irreversibleRed)
            Spacer()
            Button(copy.dismiss) { channelLeaveFailed = false }
                .controlSize(.small)
        }
        .padding(.horizontal, MomoTheme.ChannelHeader.edgeInset)
        .padding(.vertical, MomoTheme.ChannelHeader.standardSpacing)
        .accessibilityIdentifier("channelLeaveError")
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
                    openMemberDirectory: onOpenMemberDirectory,
                    sidebarToggle: sidebarToggle,
                    isChannelMenuPresented: $isChannelMenuPresented
                )
            } else {
                HStack(spacing: MomoTheme.ChannelHeader.contentSpacing) {
                    if let sidebarToggle {
                        Button(action: sidebarToggle) {
                            Label(copy.toggleSidebar, systemImage: "sidebar.leading")
                                .labelStyle(.iconOnly)
                                .frame(
                                    width: MomoTheme.ChannelHeader.actionSize,
                                    height: MomoTheme.ChannelHeader.actionSize
                                )
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .momoQuickTooltip(copy.toggleSidebar)
                        .accessibilityLabel(copy.toggleSidebar)
                        .accessibilityIdentifier("sidebar-toggle")
                    }

                    Text(copy.selectChannel)
                        .font(MomoTheme.Typography.row)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.leading, MomoTheme.ChannelHeader.edgeInset + centerHeaderLeadingInset)
                .frame(
                    maxWidth: .infinity,
                    minHeight: MomoWindowChromeLayout.integratedHeaderHeight
                )
                .momoSurface(.panel, cornerRadius: 0)
            }
        }
    }

    private var emptyChannelActions: MomoEmptyChannelOnboardingPolicy.Actions {
        let canManageChannelMembers = viewModel.selectedChannel.map {
            MomoChannelActionPolicy.canManageMembers(
                in: $0,
                canManageWorkspace: viewModel.canManageWorkspace
            )
        } ?? false
        return MomoEmptyChannelOnboardingPolicy.actions(
            canManageChannelMembers: canManageChannelMembers,
            invitePeopleAvailable: onInviteToChannel != nil,
            createAgentAvailable: onCreateAgent != nil
        )
    }

    private var channelMenuLeadingInset: CGFloat {
        MomoTheme.ChannelHeader.edgeInset
            + centerHeaderLeadingInset
            + (sidebarToggle == nil
                ? 0
                : MomoTheme.ChannelHeader.actionSize + MomoTheme.ChannelHeader.contentSpacing)
    }

    private func channelActionPanel(
        channel: Channel,
        copy: MomoWorkspaceCopy
    ) -> some View {
        let canOpenSettings = MomoChannelActionPolicy.canOpenSettings(in: channel)
            && onOpenChannelSettings != nil
        let canInvite = MomoChannelActionPolicy.canManageMembers(
            in: channel,
            canManageWorkspace: viewModel.canManageWorkspace
        ) && onInviteToChannel != nil
        let hasPrimaryActions = canOpenSettings || onOpenMemberDirectory != nil || canInvite

        return VStack(alignment: .leading, spacing: MomoTheme.ChannelHeader.compactSpacing) {
            if canOpenSettings {
                channelMenuAction(
                    copy.channelSettings,
                    systemImage: "gearshape",
                    target: .settings
                ) {
                    isChannelMenuPresented = false
                    onOpenChannelSettings?(channel.id)
                }
            }

            if let onOpenMemberDirectory {
                channelMenuAction(
                    copy.openMemberDirectory,
                    systemImage: "person.2",
                    target: .members
                ) {
                    isChannelMenuPresented = false
                    onOpenMemberDirectory()
                }
            }

            if canInvite {
                channelMenuAction(
                    copy.inviteToChannel,
                    systemImage: "person.badge.plus",
                    target: .invite
                ) {
                    isChannelMenuPresented = false
                    onInviteToChannel?(channel.id)
                }
            }

            if hasPrimaryActions {
                Divider()
            }

            channelMenuAction(
                copy.copyChannelID,
                systemImage: "doc.on.doc",
                target: .copyID
            ) {
                copyChannelID(channel.id)
                isChannelMenuPresented = false
            }

            if channel.kind != .dm {
                Divider()
                channelMenuAction(
                    copy.leaveChannel,
                    systemImage: "rectangle.portrait.and.arrow.right",
                    target: .leave
                ) {
                    isChannelMenuPresented = false
                    channelLeaveConfirmation = channel
                }
            }
        }
        .padding(MomoTheme.ChannelHeader.edgeInset)
        .frame(width: MomoTheme.ChannelHeader.menuWidth, alignment: .leading)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerLarge)
        .overlay {
            Button {
                isChannelMenuPresented = false
            } label: {
                EmptyView()
            }
            .keyboardShortcut(.cancelAction)
            .frame(width: 0, height: 0)
            .accessibilityLabel(copy.closeChannelMenu)
        }
        .accessibilityAddTraits(.isModal)
        .onAppear {
            let initialTarget: MomoChannelMenuFocusTarget = if canOpenSettings {
                .settings
            } else if onOpenMemberDirectory != nil {
                .members
            } else if canInvite {
                .invite
            } else {
                .copyID
            }
            Task { @MainActor in
                await Task.yield()
                channelMenuKeyboardFocus = initialTarget
                channelMenuAccessibilityFocus = initialTarget
            }
        }
        .onExitCommand {
            isChannelMenuPresented = false
        }
    }

    private func channelMenuAction(
        _ title: String,
        systemImage: String,
        target: MomoChannelMenuFocusTarget,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: MomoTheme.ChannelHeader.contentSpacing) {
                Image(systemName: systemImage)
                    .font(.body.weight(.semibold))
                    .frame(width: MomoTheme.ChannelHeader.actionSize)
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.body)
                Spacer()
            }
            .padding(.horizontal, MomoTheme.ChannelHeader.contentSpacing)
            .padding(.vertical, MomoTheme.ChannelHeader.standardSpacing)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focusable()
        .focused($channelMenuKeyboardFocus, equals: target)
        .accessibilityFocused($channelMenuAccessibilityFocus, equals: target)
        .help(title)
    }

    private func copyChannelID(_ channelID: ChannelID) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(channelID.description, forType: .string)
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
            messages: viewModel.visibleMessages.filter { $0.rootId == nil },
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
                                TimelineEmptyState(
                                    copy: copy,
                                    actions: emptyChannelActions,
                                    focusComposer: { isComposerFocused = true },
                                    invitePeople: {
                                        guard let id = viewModel.selectedChannelId else { return }
                                        onInviteToChannel?(id)
                                    },
                                    createAgent: {
                                        guard let id = viewModel.selectedChannelId else { return }
                                        onCreateAgent?(id)
                                    }
                                )
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
                                copy: copy,
                                isCancellationInFlight: viewModel.runCancellationIDs.contains(partial.runId),
                                cancellationIssue: viewModel.runCancellationIssues[partial.runId],
                                onStop: {
                                    Task { await viewModel.cancelRun(partial.runId) }
                                }
                            )
                            .padding(.top, 8)
                        }

                        ForEach(viewModel.visibleWorkingAgents) { agent in
                            AgentWorkingTimelineRow(
                                agent: agent,
                                signal: timelineWorkingSignal(for: agent.id),
                                copy: copy
                            )
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
                .onChange(of: viewModel.requestedMessageFocus) { _, messageID in
                    guard let messageID else { return }
                    isPinnedToTimelineBottom = false
                    proxy.scrollTo(messageID, anchor: .center)
                    highlightedMessageID = messageID
                    accessibilityFocusedMessageID = messageID
                    viewModel.consumeRequestedMessageFocus(messageID)
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(2))
                        if highlightedMessageID == messageID {
                            highlightedMessageID = nil
                        }
                    }
                }
            }
        }
    }

    private func messageTimelineItem(
        _ item: MessageTimelineItem,
        copy: MomoWorkspaceCopy
    ) -> some View {
        let canInteract = viewModel.canInteractWithMessage(item.message)
        let canModify = viewModel.canModifyMessage(item.message)
        return VStack(alignment: .leading, spacing: 0) {
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
                reactions: viewModel.reactions(for: item.message),
                replyCount: viewModel.threadReplyCount(for: item.message),
                canModify: canModify,
                interactionError: viewModel.messageInteractionErrors[item.message.id],
                onToggleReaction: canInteract
                    ? { emoji in
                        Task { await viewModel.toggleReaction(emoji, on: item.message) }
                    }
                    : nil,
                onOpenThread: {
                    onPresentThread()
                    selectedThreadRootID = item.message.rootId ?? item.message.id
                },
                onOpenWorkTerminal: workTerminalAction(for: item.message),
                onOpenWorkSession: workSessionAction(for: item.message),
                onEdit: canModify
                    ? { body in
                        await viewModel.editMessage(item.message, body: body)
                    }
                    : nil,
                onDelete: canModify
                    ? {
                        Task {
                            let didDelete = await viewModel.deleteMessage(item.message)
                            if didDelete, selectedThreadRootID == item.message.id {
                                selectedThreadRootID = nil
                                onDismissThread()
                            }
                        }
                    }
                    : nil,
                onDismissInteractionError: {
                    viewModel.clearMessageInteractionError(item.message.id)
                },
                attachmentDownloadStates: viewModel.attachmentDownloadStates,
                onDownloadAttachment: { attachment in
                    Task {
                        await viewModel.downloadAttachment(
                            attachment,
                            from: item.message.channelId
                        )
                    }
                },
                onOpenAttachment: viewModel.openDownloadedAttachment,
                groupingStyle: item.startsGroup ? .groupStart : .compact,
                timelineCopy: copy,
                presentation: presentation,
                memoryDelivery: item.message.runId.flatMap(viewModel.memoryDelivery(for:)),
                onOpenServedContext: item.message.runId.flatMap(servedContextAction(for:))
            )
            .padding(.top, item.startsGroup ? 8 : 0)
            .background(
                highlightedMessageID == item.message.id
                    ? MomoTheme.selectionBackground
                    : Color.clear
            )
            .accessibilityFocused($accessibilityFocusedMessageID, equals: item.message.id)
        }
        .id(item.id)
        .onAppear {
            viewModel.messageDidRender(item.message)
        }
    }

    private func workTerminalAction(for message: Message) -> (() -> Void)? {
        guard message.props["kind"]?.stringValue == "work_session",
              let rawSessionId = message.props["session_id"]?.stringValue,
              let sessionId = WorkSessionID(uuidString: rawSessionId),
              canOpenWorkTerminal(sessionId)
        else { return nil }
        return { onOpenWorkTerminal(sessionId) }
    }

    private func workSessionAction(for message: Message) -> (() -> Void)? {
        guard message.props["kind"]?.stringValue == "resume_offer",
              let rawOwnerID = message.props["owner_member_id"]?.stringValue,
              let ownerID = MemberID(uuidString: rawOwnerID.lowercased()),
              ownerID == viewModel.currentNavigationMemberID,
              let rawSessionID = message.props["session_id"]?.stringValue,
              let sessionID = WorkSessionID(uuidString: rawSessionID.lowercased())
        else { return nil }
        return { onOpenWorkSession(sessionID) }
    }

    private var threadRoot: Message? {
        guard let selectedThreadRootID else { return nil }
        return viewModel.visibleMessages.first { $0.id == selectedThreadRootID && !$0.isDeleted }
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
                memoryDelivery: viewModel.memoryDelivery(for: run.id),
                onOpenServedContext: servedContextAction(for: run.id),
                isCancellationInFlight: viewModel.runCancellationIDs.contains(run.id),
                cancellationIssue: viewModel.runCancellationIssues[run.id],
                onStop: viewModel.effectiveWorkStatus(for: run).isTerminal
                    ? nil
                    : { Task { await viewModel.cancelRun(run.id) } },
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

    private func servedContextAction(for runID: RunID) -> (() -> Void)? {
        guard let packetID = viewModel.contextPacketID(for: runID) else { return nil }
        return {
            servedContextSelection = MomoServedContextSelection(id: packetID)
        }
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
            if !attachmentDrafts.isEmpty {
                MomoAttachmentDraftStrip(
                    drafts: attachmentDrafts,
                    copy: MomoComposerActionCopy(language: language),
                    onRemove: removeAttachmentDraft,
                    onRetry: retryAttachmentDraft,
                    onClear: clearAttachmentDrafts
                )
            }

            if hasLocalStructuredDrafts {
                localStructuredDraftSummary
            }

            composerSurface(candidates: candidates, copy: copy)

            AgentWorkingComposerBar(
                signals: composerFooterSignals,
                copy: copy
            )
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
        HStack(alignment: .center, spacing: 8) {
            ZStack {
                Button {
                    isActionLauncherPresented.toggle()
                } label: {
                    ZStack {
                        Image(systemName: "plus")
                            .font(.title3.weight(.medium))
                            .offset(y: -1)
                    }
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

            MomoHuddleComposerControl(
                viewModel: huddleViewModel,
                copy: MomoHuddleCopy(language: language),
                isChannelSelected: viewModel.selectedChannelId != nil
            )

            Button(action: presentWorkComposer) { EmptyView() }
                .keyboardShortcut("w", modifiers: [.command, .shift])
                .frame(width: 0, height: 0)
                .opacity(0)
                .disabled(viewModel.selectedChannelId == nil)
                .allowsHitTesting(false)
                .accessibilityHidden(true)

            ZStack(alignment: .topLeading) {
                MomoMessageComposerTextView(
                    text: $viewModel.composerDraft,
                    height: $composerEditorHeight,
                    isFocused: Binding(
                        get: { isComposerFocused },
                        set: { isComposerFocused = $0 }
                    ),
                    accessibilityLabel: copy.messagePlaceholder,
                    hasMentionCandidates: !candidates.isEmpty,
                    onSubmit: {
                        if candidates.isEmpty {
                            submit()
                        } else {
                            completeSelectedMention(from: candidates)
                        }
                    },
                    onMoveMentionSelection: { offset in
                        _ = moveMentionSelection(in: candidates, offset: offset)
                    },
                    onCompleteMention: {
                        completeSelectedMention(from: candidates)
                    },
                    onDismissMention: {
                        suppressedMentionDraft = viewModel.composerDraft
                        selectedMentionCandidateID = nil
                    }
                )
                .frame(height: composerEditorHeight)
                .accessibilityIdentifier("momo-message-composer")

                if viewModel.composerDraft.isEmpty {
                    Text(copy.messagePlaceholder)
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.vertical, MomoTheme.ComposerAction.contentSpacing)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .onChange(of: viewModel.composerDraft) { _, draft in
                if draft != suppressedMentionDraft {
                    suppressedMentionDraft = nil
                }
                viewModel.composerDraftDidChange(draft)
            }

            Button(action: submit) {
                ZStack {
                    if isSendingComposerMessage {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.body.weight(.medium))
                            .offset(y: -1)
                    }
                }
                .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
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
            onOpenPluginMarketplace()
        }
    }

    private var huddleActivationID: String {
        "\(viewModel.workspaceId?.description ?? "none"):\(viewModel.selectedChannelId?.description ?? "none")"
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

    @discardableResult
    private func addAttachmentDrafts(_ urls: [URL]) -> Int {
        guard let channelID = viewModel.selectedChannelId else { return 0 }
        let regularFiles = urls.filter { url in
            guard url.isFileURL else { return false }
            return (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }
        attachmentDraftsByChannel[channelID] = MomoAttachmentDraftCollection.merging(
            attachmentDraftsByChannel[channelID] ?? [],
            urls: regularFiles
        )
        return regularFiles.count
    }

    private func removeAttachmentDraft(_ draft: MomoAttachmentDraft) {
        guard let channelID = viewModel.selectedChannelId else { return }
        guard draft.state != .uploading else { return }
        attachmentDraftsByChannel[channelID]?.removeAll { $0.id == draft.id }
    }

    private func clearAttachmentDrafts() {
        guard let channelID = viewModel.selectedChannelId else { return }
        guard attachmentDraftsByChannel[channelID]?.contains(where: { $0.state == .uploading }) != true else {
            return
        }
        attachmentDraftsByChannel[channelID] = []
    }

    private func retryAttachmentDraft(_ draft: MomoAttachmentDraft) {
        guard let channelID = viewModel.selectedChannelId else { return }
        Task { _ = await uploadAttachmentDraft(draft, in: channelID) }
    }

    @discardableResult
    private func uploadAttachmentDraft(
        _ draft: MomoAttachmentDraft,
        in channelID: ChannelID
    ) async -> MessageAttachment? {
        if case .uploaded(let attachment) = draft.state {
            return attachment
        }
        updateAttachmentDraft(draft.id, in: channelID, state: .uploading)
        do {
            let attachment = try await viewModel.uploadAttachment(fileURL: draft.url, to: channelID)
            updateAttachmentDraft(draft.id, in: channelID, state: .uploaded(attachment))
            return attachment
        } catch let issue as MomoAttachmentTransferIssue where issue == .fileTooLarge {
            updateAttachmentDraft(draft.id, in: channelID, state: .failed(.fileTooLarge))
        } catch is CancellationError {
            updateAttachmentDraft(draft.id, in: channelID, state: .ready)
        } catch {
            updateAttachmentDraft(draft.id, in: channelID, state: .failed(.unavailable))
        }
        return nil
    }

    private func updateAttachmentDraft(
        _ id: URL,
        in channelID: ChannelID,
        state: MomoAttachmentDraft.State
    ) {
        guard let index = attachmentDraftsByChannel[channelID]?.firstIndex(where: { $0.id == id }) else {
            return
        }
        attachmentDraftsByChannel[channelID]?[index].state = state
    }

    private var attachmentDrafts: [MomoAttachmentDraft] {
        guard let channelID = viewModel.selectedChannelId else { return [] }
        return attachmentDraftsByChannel[channelID] ?? []
    }

    private var hasLocalStructuredDrafts: Bool {
        !threadTopic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pollQuestion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || pollOptions.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
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
        threadTopic = ""
        pollQuestion = ""
        pollOptions = ["", ""]
    }

    private var selectedPluginsDefaultsKey: String {
        let server = normalizedServerIdentity
        let workspace = viewModel.workspaceId?.description ?? "demo"
        let member = viewModel.currentNavigationMemberID?.description ?? "anonymous"
        return "momo.plugins.localSelected.v1.\(server).\(workspace).\(member)"
    }

    private var normalizedServerIdentity: String {
        let value = serverIdentity?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "demo"
        return value.data(using: .utf8)?.base64EncodedString() ?? "demo"
    }

    private func pruneAttachmentDrafts() {
        let allowed = Set(viewModel.channels.map(\.id))
        attachmentDraftsByChannel = attachmentDraftsByChannel.filter { allowed.contains($0.key) }
    }

    private func loadSelectedPlugins() {
        let raw = UserDefaults.standard.string(forKey: selectedPluginsDefaultsKey) ?? ""
        selectedPlugins = Set(raw.split(separator: "\n").map(String.init))
    }

    private func saveSelectedPlugins() {
        UserDefaults.standard.set(
            selectedPlugins.sorted().joined(separator: "\n"),
            forKey: selectedPluginsDefaultsKey
        )
    }

    private var canSendMessage: Bool {
        !isSendingComposerMessage
            && !attachmentDrafts.contains { $0.state == .uploading }
            && viewModel.selectedChannelId != nil
            && (
                !viewModel.composerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || !attachmentDrafts.isEmpty
            )
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
        guard canSendMessage, let channel = viewModel.selectedChannelId else { return }
        let body = viewModel.composerDraft
        let drafts = attachmentDrafts
        if drafts.isEmpty, let command = AgentWorkCommandParser.parse(body) {
            initialWorkBrief = command.brief
            workCommandDraftToRestore = command.draftToRestore
            workComposerSessionId = UUID()
            viewModel.clearWorkCreationError()
            viewModel.composerDraft = ""
            viewModel.composerDraftDidChange("")
            isWorkComposerPresented = true
            return
        }
        isSendingComposerMessage = true
        Task {
            var attachments: [MessageAttachment] = []
            for draft in drafts {
                guard let attachment = await uploadAttachmentDraft(draft, in: channel) else {
                    isSendingComposerMessage = false
                    return
                }
                attachments.append(attachment)
            }
            let didSend = await viewModel.send(
                body: body,
                to: channel,
                attachments: attachments
            )
            if didSend {
                let sentDraftIDs = Set(drafts.map(\.id))
                attachmentDraftsByChannel[channel]?.removeAll { sentDraftIDs.contains($0.id) }
                if viewModel.composerDraft == body {
                    viewModel.composerDraft = ""
                    viewModel.composerDraftDidChange("")
                }
            }
            isSendingComposerMessage = false
        }
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

    private func timelineWorkingSignal(for agentID: MemberID) -> AgentWorkingSignal? {
        viewModel.selectedChannelWorkingSignals.first { $0.agentId == agentID }
    }

    /// Agents whose working state is already represented in the loaded timeline:
    /// either a live partial bubble (`livePartials`) or a turn-liveness row
    /// (`visibleWorkingAgents`). This is pure derived data (partials, work runs,
    /// members), independent of scroll position, so the footer dedup below stays
    /// deterministic and snapshot-stable regardless of viewport/geometry.
    private var timelineWorkingAgentIDs: Set<MemberID> {
        var ids = Set(viewModel.visibleWorkingAgents.map(\.id))
        for partial in livePartials {
            if let agentID = viewModel.agentStatuses[partial.runId]?.agentMemberId {
                ids.insert(agentID)
            }
        }
        return ids
    }

    /// Signals for the composer footer. Deterministic data rule (no scroll/geometry
    /// heuristic): an agent whose working signal already appears in the loaded
    /// timeline (as a partial bubble or a turn-liveness row) is suppressed, so the
    /// footer never reprints a headline the timeline already shows. The footer
    /// carries the headline only for agents that have no on-timeline representation.
    private var composerFooterSignals: [AgentWorkingSignal] {
        let onTimeline = timelineWorkingAgentIDs
        return viewModel.selectedChannelWorkingSignals.filter { !onTimeline.contains($0.agentId) }
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

// The empty-channel onboarding surface. Agent creation sits at equal footing with
// people invitation (MOMO-570); a non-admin sees the same surface with the request
// path instead of hidden controls.
struct TimelineEmptyState: View {
    let copy: MomoWorkspaceCopy
    let actions: MomoEmptyChannelOnboardingPolicy.Actions
    let focusComposer: () -> Void
    let invitePeople: () -> Void
    let createAgent: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            // Hierarchy comes from weight and secondary color, not size inflation:
            // the two co-equal actions below carry the intent, so the title stays
            // at body weight and no subtitle restates the button labels.
            Text(copy.emptyChannelTitle)
                .font(.body.weight(.semibold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if actions.showsManagementActions {
                // The invite/create pair reflows to a vertical stack once the
                // timeline column is narrowed by the sidebar and inspector, so
                // neither large button clips at minimum window width (MOMO-570).
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { managementActions }
                    VStack(spacing: 12) { managementActions }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            } else {
                Label(copy.emptyChannelRequestGuidance, systemImage: "person.2")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(copy.timelineEmptyAction, action: focusComposer)
                .buttonStyle(.link)
        }
        .frame(maxWidth: MomoTheme.Onboarding.emptyChannelContentMaximumWidth)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 32)
    }

    // Shared by the horizontal and vertical layouts so the reflow keeps identical
    // actions and a single keyboard shortcut.
    @ViewBuilder
    private var managementActions: some View {
        if actions.canInvitePeople {
            Button(action: invitePeople) {
                Label(copy.emptyChannelAddPeople, systemImage: "person.badge.plus")
            }
        }
        if actions.canCreateAgent {
            // Agents are first-class members, so "Add agent" is a person-badge-plus
            // sibling of "Add people" (filled to distinguish the two), never an
            // AI-magic glyph like sparkles.
            Button(action: createAgent) {
                Label(copy.emptyChannelAddAgent, systemImage: "person.fill.badge.plus")
            }
            .keyboardShortcut("a", modifiers: [.command, .shift])
        }
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

// Surface 3 (MOMO-568): the turn-liveness row. It consumes agentWorkingSignal and
// uses the static accent liveness mark plus a ticking elapsed clock, so it never
// reads as the animated three-dot "typing" affordance a human sender would get.
// It deliberately shows only "{agent} is working" + elapsed clock + the generic
// reassurance subtitle, never the signal's headline: the headline is already owned
// by the live partial bubble (and, when no bubble is on screen, the composer bar),
// so echoing it here would print the same sentence twice on one screen.
private struct AgentWorkingTimelineRow: View {
    var agent: Member
    var signal: AgentWorkingSignal?
    var copy: MomoWorkspaceCopy

    var body: some View {
        HStack(spacing: 12) {
            AgentTurnLivenessMark(accessibilityText: copy.agentWorkingTitle(agent.displayName))
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(copy.agentWorkingTitle(agent.displayName))
                        .font(.callout.weight(.semibold))
                    if let startedAt = signal?.startedAt {
                        AgentWorkingElapsedLabel(startedAt: startedAt, copy: copy)
                    }
                }
                Text(copy.agentWorkingSubtitle)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
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
