import SwiftUI
import MomoCore

// MARK: - MomoMacRootView
//
// The top-level macOS layout: a sidebar + channel timeline, with an optional
// right inspector that opens only for command center / approval / thread-like
// detail work. This keeps dogfood messaging roomy by default.
//
// All panes drive off a single ChatViewModel bound to the MomoCore contracts.

struct MomoSessionChrome {
    var summary: MomoServerSessionSummary
    var inviteAdminContext: MomoInviteAdminContext?
    var switchSession: () -> Void
    var logout: () -> Void
}

enum MomoMemberDirectoryNavigation {
    static func action(
        override: MomoMemberDirectoryHook?,
        presentDirectory: @escaping MomoMemberDirectoryHook
    ) -> MomoMemberDirectoryHook {
        override ?? presentDirectory
    }
}

public struct MomoMacRootView: View {
    @StateObject private var viewModel: ChatViewModel
    @StateObject private var quickTooltipPresenter = MomoQuickTooltipPresenter()
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var detailPanePresentation = MomoDetailPanePresentationState()
    @State private var selectedProfileMemberID: MemberID?
    @State private var selectedWorkRunID: RunID?
    @State private var splitViewVisibility: NavigationSplitViewVisibility = .all
    @State private var channelHeaderHeight: CGFloat = 0
    @State private var windowChromeMetrics = MomoWindowChromeMetrics.zero
    @State private var quickSwitcherPresentation = MomoQuickSwitcherPresentationState()
    @State private var showKeyboardShortcuts = false
    @State private var showWorkspaceSearch = false
    @State private var channelSettingsRequest: MomoChannelSettingsRequest?
    @State private var showMemberInspector = true
    @State private var memberInspectorAudience = MomoMemberInspectorAudience.channel
    @State private var composerFocusRequest: UInt64 = 0
    @State private var showDownloadsPopover = false
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoAppearancePreference.appStorageKey) private var appearanceRaw = MomoAppearancePreference.system.rawValue
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    private let sessionChrome: MomoSessionChrome?
    private let onOpenMemberDirectory: MomoMemberDirectoryHook?
    private static let attachedInspectorMinimumWindowWidth: CGFloat = 1_360
    private static let inspectorWidth: CGFloat = 440

    /// Inject a configured ViewModel (e.g. backed by LiveChatBackend).
    public init(
        viewModel: @autoclosure @escaping () -> ChatViewModel,
        onOpenMemberDirectory: MomoMemberDirectoryHook? = nil
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.sessionChrome = nil
        self.onOpenMemberDirectory = onOpenMemberDirectory
    }

    /// Host an already-created ViewModel, used by async bootstraps such as the
    /// SwiftPM development app entrypoint.
    public init(
        existingViewModel viewModel: ChatViewModel,
        onOpenMemberDirectory: MomoMemberDirectoryHook? = nil
    ) {
        _viewModel = StateObject(wrappedValue: viewModel)
        self.sessionChrome = nil
        self.onOpenMemberDirectory = onOpenMemberDirectory
    }

    init(
        existingViewModel viewModel: ChatViewModel,
        sessionChrome: MomoSessionChrome?,
        onOpenMemberDirectory: MomoMemberDirectoryHook? = nil,
        initialDetailPane: MomoMacDetailPane? = nil,
        initialSplitViewVisibility: NavigationSplitViewVisibility = .all
    ) {
        _viewModel = StateObject(wrappedValue: viewModel)
        _splitViewVisibility = State(initialValue: initialSplitViewVisibility)
        self.sessionChrome = sessionChrome
        self.onOpenMemberDirectory = onOpenMemberDirectory
        if let initialDetailPane {
            _detailPanePresentation = State(
                initialValue: MomoDetailPanePresentationState(
                    isPresented: true,
                    pane: initialDetailPane
                )
            )
        }
    }

    public var body: some View {
        let copy = MomoWorkspaceCopy(language: language)

        NavigationSplitView(columnVisibility: $splitViewVisibility) {
            sidebar(copy: copy)
                .navigationSplitViewColumnWidth(
                    min: MomoTheme.Sidebar.minimumWidth,
                    ideal: MomoTheme.Sidebar.idealWidth,
                    max: MomoTheme.Sidebar.maximumWidth
                )
        } detail: {
            GeometryReader { geometry in
                let topInset = MomoWindowChromeLayout.contentTopInset(
                    windowChromeTopInset: windowChromeMetrics.topInset
                )

                detailLayout(
                    copy: copy,
                    availableDetailWidth: geometry.size.width,
                    useAttachedInspector: geometry.size.width >= Self.attachedInspectorMinimumWindowWidth,
                    useAttachedMemberInspector: MomoMemberInspectorLayout.usesAttachedInspector(
                        detailWidth: geometry.size.width
                    )
                )
                .frame(
                    width: geometry.size.width,
                    height: max(0, geometry.size.height - topInset)
                )
                .padding(.top, topInset)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .coordinateSpace(name: MomoQuickTooltipCoordinateSpace.window)
        .environment(\.momoWindowChromeTopInset, windowChromeMetrics.topInset)
        .environment(\.momoQuickTooltipPresenter, quickTooltipPresenter)
        .background {
            MomoWindowChromeMetricsReader { metrics in
                guard metrics != windowChromeMetrics else { return }
                windowChromeMetrics = metrics
            }
            .frame(width: 0, height: 0)

        }
        // NavigationSplitView clips the native sidebar to a rounded container
        // below unified toolbar chrome. Matching the window underlay to the
        // sidebar panel prevents the clip from reading as a gap or shadow;
        // each detail surface paints its own semantic background above it.
        .background(
            MomoTheme.Surface.style(.panel, colorScheme: colorScheme).fill
                .ignoresSafeArea()
        )
        .preferredColorScheme(appearance.colorScheme)
        .focusedSceneValue(\.momoMacCommandActions, commandActions)
        .toolbar {
            globalToolbar(copy: copy)
        }
        .overlay {
            commandPaletteOverlay(copy: copy)
        }
        .overlay {
            MomoQuickTooltipOverlay(presenter: quickTooltipPresenter)
        }
        .sheet(isPresented: $showKeyboardShortcuts) {
            MomoKeyboardShortcutsView(copy: copy)
        }
        .sheet(item: $channelSettingsRequest) { request in
            if let channel = viewModel.channels.first(where: { $0.id == request.channelID }) {
                MomoChannelSettingsSheet(
                    copy: copy,
                    channel: channel,
                    presentation: MomoLocalChannelPresentationStore.presentation(for: channel),
                    viewModel: viewModel,
                    initialTab: request.initialTab,
                    onSavePresentation: { _ in }
                )
                .id(request.id)
            }
        }
        .onAppear {
            MomoDockUnreadBadgeController.apply(viewModel.readStatesByChannel)
        }
        .onChange(of: viewModel.readStatesByChannel) { _, states in
            MomoDockUnreadBadgeController.apply(states)
        }
        .onDisappear {
            MomoDockUnreadBadgeController.clear()
        }
        .onChange(of: developerMode) { _, isEnabled in
            if !isEnabled, detailPane == .alpha {
                detailPanePresentation.redirect(to: .approvals)
            }
        }
    }

    private func detailLayout(
        copy: MomoWorkspaceCopy,
        availableDetailWidth: CGFloat,
        useAttachedInspector: Bool,
        useAttachedMemberInspector: Bool
    ) -> some View {
        let inspectorTopInset = MomoWindowChromeLayout.inspectorTopInset(
            channelHeaderHeight: channelHeaderHeight
        )
        let showsMemberInspector = showMemberInspector && !showDetailPane
        let blocksTimelineForMemberOverlay = MomoMemberInspectorLayout.blocksTimelineInteraction(
            isPresented: showsMemberInspector,
            usesAttachedInspector: useAttachedMemberInspector
        )

        return ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                messageTimeline
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(!blocksTimelineForMemberOverlay)
                    .accessibilityHidden(blocksTimelineForMemberOverlay)

                if showDetailPane && useAttachedInspector {
                    Divider()

                    GeometryReader { inspectorGeometry in
                        let paneHeight = max(0, inspectorGeometry.size.height - inspectorTopInset)
                        VStack(spacing: 0) {
                            Color.clear
                                .frame(height: inspectorTopInset)
                                .momoFlatSurface(.panel)
                                .overlay(alignment: .bottom) {
                                    Divider()
                                }

                            detailPaneView(copy: copy, presentation: .attached)
                                .frame(width: Self.inspectorWidth, height: paneHeight)
                        }
                    }
                    .frame(width: Self.inspectorWidth)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                } else if showsMemberInspector && useAttachedMemberInspector {
                    Divider()

                    memberInspectorView(copy: copy, isAttached: true)
                        .frame(width: MomoTheme.MemberInspector.attachedWidth)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if showDetailPane && !useAttachedInspector {
                // This region intentionally starts below the measured channel
                // header. The scrim must obey the same boundary as the drawer.
                GeometryReader { inspectorGeometry in
                    let regionHeight = max(0, inspectorGeometry.size.height - inspectorTopInset)
                    ZStack(alignment: .trailing) {
                        MomoTheme.modalScrim
                            .transition(.opacity)
                            .contentShape(Rectangle())
                            .onTapGesture {
                                closeDetailPane()
                            }

                        detailPaneView(copy: copy, presentation: .overlay)
                            .frame(width: overlayInspectorWidth(for: availableDetailWidth))
                            .padding(.trailing, 12)
                            .padding(.vertical, 8)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                    .frame(width: inspectorGeometry.size.width, height: regionHeight)
                    .position(
                        x: inspectorGeometry.size.width / 2,
                        y: inspectorTopInset + regionHeight / 2
                    )
                }
            } else if showsMemberInspector && !useAttachedMemberInspector {
                GeometryReader { inspectorGeometry in
                    let regionHeight = max(0, inspectorGeometry.size.height - inspectorTopInset)
                    ZStack(alignment: .trailing) {
                        MomoTheme.modalScrim
                            .transition(.opacity)
                            .contentShape(Rectangle())
                            .accessibilityHidden(true)
                            .onTapGesture {
                                closeMemberInspector()
                            }

                        memberInspectorView(copy: copy, isAttached: false)
                            .frame(width: memberInspectorOverlayWidth(for: availableDetailWidth))
                            .padding(.trailing, MomoTheme.MemberInspector.standardSpacing)
                            .padding(.vertical, MomoTheme.MemberInspector.standardSpacing)
                            .accessibilityAddTraits(.isModal)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                    .frame(width: inspectorGeometry.size.width, height: regionHeight)
                    .position(
                        x: inspectorGeometry.size.width / 2,
                        y: inspectorTopInset + regionHeight / 2
                    )
                }
            }
        }
        .animation(layoutAnimation, value: showDetailPane)
        .animation(layoutAnimation, value: showMemberInspector)
    }

    private func sidebar(copy: MomoWorkspaceCopy) -> some View {
        ChannelListView(
            viewModel: viewModel,
            sessionChrome: sessionChrome,
            openCommandCenter: {
                if developerMode {
                    openDetailPane(.alpha)
                }
            },
            openApprovals: {
                openDetailPane(.approvals)
            },
            openProfile: {
                openDetailPane(.profile)
            },
            openMemberProfile: { memberID in
                selectedProfileMemberID = memberID
                openDetailPane(.memberProfile)
            },
            openWorkspaceSettings: {
                openDetailPane(.workspaceSettings)
            },
            openSettings: {
                openDetailPane(.settings)
            },
            openUpdates: {
                openDetailPane(.updates)
            },
            openMemberDirectory: {
                openWorkspaceMemberInspector()
            },
            openChannelSettings: { channelID in
                presentChannelSettings(channelID, initialTab: .general)
            },
            inviteToChannel: viewModel.canManageWorkspace
                ? { channelID in
                    presentChannelSettings(channelID, initialTab: .members)
                }
                : nil,
            showsWorkspaceHeader: true
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var messageTimeline: some View {
        MessageListView(
            viewModel: viewModel,
            onOpenWorkDetail: { runId in
                selectedWorkRunID = runId
                openDetailPane(.work)
            },
            onRequestLogin: {
                sessionChrome?.switchSession()
            },
            onOpenMemberDirectory: memberDirectoryAction,
            focusComposerRequest: composerFocusRequest,
            serverIdentity: sessionChrome?.summary.serverURLString,
            onChannelHeaderHeightChange: { newHeight in
                guard newHeight > 0, abs(channelHeaderHeight - newHeight) > 0.5 else { return }
                channelHeaderHeight = newHeight
            }
        )
            .frame(minWidth: 0)
    }

    @ToolbarContentBuilder
    private func globalToolbar(copy: MomoWorkspaceCopy) -> some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                showDownloadsPopover.toggle()
            } label: {
                Label(copy.appDownloads, systemImage: "arrow.down.circle")
                    .labelStyle(.iconOnly)
            }
            .help(copy.appDownloads)
            .momoQuickTooltip(copy.appDownloads)
            .accessibilityLabel(copy.appDownloads)
            .accessibilityHint(copy.downloadsScopeNote)
            .accessibilityIdentifier("app-downloads-entry")
            .popover(isPresented: $showDownloadsPopover, arrowEdge: .top) {
                MomoDownloadsPopoverView(copy: copy)
            }
        }

        ToolbarItem(placement: .automatic) {
            Button {
                quickSwitcherPresentation.dismiss()
                showWorkspaceSearch.toggle()
            } label: {
                Label(copy.workspaceSearch, systemImage: "magnifyingglass")
                    .labelStyle(.iconOnly)
            }
            .help(copy.workspaceSearch)
            .accessibilityLabel(copy.workspaceSearch)
            .accessibilityIdentifier("workspace-search-entry")
        }

    }

    private var memberDirectoryAction: MomoMemberDirectoryHook {
        MomoMemberDirectoryNavigation.action(
            override: onOpenMemberDirectory,
            presentDirectory: {
                openChannelMemberInspector()
            }
        )
    }

    private func memberInspectorView(copy: MomoWorkspaceCopy, isAttached: Bool) -> some View {
        MomoChannelMemberInspectorView(
            viewModel: viewModel,
            audience: memberInspectorAudience,
            copy: copy,
            close: closeMemberInspector,
            didOpenDirectMessage: {
                memberInspectorAudience = .channel
                if !isAttached {
                    closeMemberInspector()
                }
            },
            presentation: isAttached ? .attached : .overlay
        )
    }

    private func openChannelMemberInspector() {
        withAnimation(layoutAnimation) {
            if showMemberInspector, memberInspectorAudience == .channel, !showDetailPane {
                showMemberInspector = false
                composerFocusRequest &+= 1
            } else {
                detailPanePresentation.close()
                memberInspectorAudience = .channel
                showMemberInspector = true
            }
        }
    }

    private func openWorkspaceMemberInspector() {
        withAnimation(layoutAnimation) {
            detailPanePresentation.close()
            memberInspectorAudience = .workspace
            showMemberInspector = true
        }
    }

    private func closeMemberInspector() {
        withAnimation(layoutAnimation) {
            showMemberInspector = false
            composerFocusRequest &+= 1
        }
    }

    private func detailPaneView(copy: MomoWorkspaceCopy, presentation: MomoInspectorPresentation) -> some View {
        let visibleDetailPane = detailPane == .alpha && !developerMode ? MomoMacDetailPane.approvals : detailPane

        return VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: visibleDetailPane.systemImage)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(visibleDetailPane.tint)
                    .frame(width: 32, height: 32)
                    .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(visibleDetailPane.title(copy: copy))
                        .font(.headline)
                    Text(visibleDetailPane.subtitle(copy: copy))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 8)

                Button {
                    closeDetailPane()
                } label: {
                    Label(copy.closeDetailPane, systemImage: "xmark")
                        .labelStyle(.titleAndIcon)
                        .font(MomoTheme.Typography.supporting.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)
                .help(copy.closeDetailPane)
                .momoQuickTooltip(copy.closeDetailPane)
                .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            if let relatedPane = visibleDetailPane.relatedOperationalPane,
               relatedPane != .alpha || developerMode {
                HStack {
                    Button {
                        openDetailPane(relatedPane)
                    } label: {
                        Label(relatedPane.title(copy: copy), systemImage: relatedPane.systemImage)
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderless)
                    .help(relatedPane.subtitle(copy: copy))
                    .momoQuickTooltip(relatedPane.subtitle(copy: copy))
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }

            Divider()

            switch visibleDetailPane {
            case .alpha:
                AlphaCommandCenterView(viewModel: viewModel)
            case .approvals:
                ApprovalInboxView(
                    viewModel: viewModel,
                    inspectorPresentation: presentation
                )
            case .work:
                if let selectedWorkRunID {
                    AgentWorkRunDetailView(
                        viewModel: viewModel,
                        runId: selectedWorkRunID,
                        copy: copy
                    )
                } else {
                    Text(copy.workTranscriptEmpty)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(16)
                }
            case .profile:
                MomoProfileSettingsSurface(
                    copy: copy,
                    summary: sessionChrome?.summary,
                    member: viewModel.authenticatedMember,
                    allowsEditing: viewModel.allowsLocalProfileEditing
                )
            case .memberProfile:
                if let member = selectedProfileMemberID.flatMap({ viewModel.member($0) }) {
                    MomoMemberProfileSettingsSurface(
                        copy: copy,
                        member: member,
                        viewModel: viewModel
                    ) { displayName, avatarPath, presence in
                        viewModel.applyLocalProfile(
                            member: member.id,
                            displayName: displayName,
                            avatarPath: avatarPath,
                            presence: presence
                        )
                    }
                    .id(member.id)
                } else {
                    MomoEmptyProfileSelectionView(copy: copy)
                }
            case .settings:
                MomoAppSettingsSurface(copy: copy)
            case .workspaceSettings:
                MomoWorkspaceSettingsSurface(copy: copy, viewModel: viewModel)
            case .downloads:
                MomoDownloadsSettingsSurface(copy: copy)
            case .updates:
                MomoUpdateStatusSurface(copy: copy)
            }
        }
        .frame(width: presentation == .attached ? Self.inspectorWidth : nil)
        .momoInspectorSurface(presentation)
    }

    private func openDetailPane(_ pane: MomoMacDetailPane) {
        guard pane != .alpha || developerMode else { return }
        withAnimation(layoutAnimation) {
            detailPanePresentation.present(pane)
        }
    }

    private func closeDetailPane() {
        withAnimation(layoutAnimation) {
            detailPanePresentation.close()
        }
    }

    private func presentChannelSettings(
        _ channelID: ChannelID,
        initialTab: MomoChannelSettingsTab
    ) {
        guard let channel = viewModel.channels.first(where: { $0.id == channelID }),
              MomoChannelActionPolicy.canOpenSettings(in: channel),
              initialTab != .members || MomoChannelActionPolicy.canManageMembers(
                in: channel,
                canManageWorkspace: viewModel.canManageWorkspace
              )
        else { return }
        channelSettingsRequest = MomoChannelSettingsRequest(
            channelID: channelID,
            initialTab: initialTab
        )
    }

    private func overlayInspectorWidth(for detailWidth: CGFloat) -> CGFloat {
        min(Self.inspectorWidth, max(340, detailWidth - 28))
    }

    private func memberInspectorOverlayWidth(for detailWidth: CGFloat) -> CGFloat {
        min(
            MomoTheme.MemberInspector.overlayWidth,
            max(MomoTheme.MemberDirectory.listIdealWidth, detailWidth - 24)
        )
    }

    private var layoutAnimation: Animation? {
        reduceMotion ? nil : MomoTheme.Motion.stateChange
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private var appearance: MomoAppearancePreference {
        MomoAppearancePreference(rawValue: appearanceRaw) ?? .system
    }

    private var showDetailPane: Bool {
        detailPanePresentation.isPresented
    }

    private var detailPane: MomoMacDetailPane {
        detailPanePresentation.pane
    }

    private var selectedChannel: Channel? {
        guard let selectedChannelID = viewModel.selectedChannelId else { return nil }
        return viewModel.channels.first(where: { $0.id == selectedChannelID })
    }

    private var commandActions: MomoMacCommandActions {
        MomoMacCommandActions(
            language: language,
            channelCount: viewModel.sidebarChannelOrder.orderedChannels.count,
            canNavigateBackward: viewModel.canNavigateChannelHistoryBackward,
            canNavigateForward: viewModel.canNavigateChannelHistoryForward,
            canNavigateUnreadChannels: viewModel.canNavigateUnreadChannels,
            canOpenSelectedChannelSettings: selectedChannel.map {
                MomoChannelActionPolicy.canOpenSettings(in: $0)
            } ?? false,
            canInviteToSelectedChannel: selectedChannel.map {
                MomoChannelActionPolicy.canManageMembers(
                    in: $0,
                    canManageWorkspace: viewModel.canManageWorkspace
                )
            } ?? false,
            presentQuickSwitcher: {
                showKeyboardShortcuts = false
                showWorkspaceSearch = false
                quickSwitcherPresentation.toggle()
            },
            presentWorkspaceSearch: {
                quickSwitcherPresentation.dismiss()
                showWorkspaceSearch = true
            },
            presentChannelSettings: {
                guard let channelID = viewModel.selectedChannelId else { return }
                presentChannelSettings(channelID, initialTab: .general)
            },
            inviteToChannel: {
                guard let channelID = viewModel.selectedChannelId else { return }
                presentChannelSettings(channelID, initialTab: .members)
            },
            openDownloads: {
                quickSwitcherPresentation.dismiss()
                showDownloadsPopover = true
            },
            selectChannel: { number in
                quickSwitcherPresentation.dismiss()
                Task { await viewModel.selectChannel(shortcutNumber: number) }
            },
            navigateBackward: {
                quickSwitcherPresentation.dismiss()
                Task { await viewModel.navigateChannelHistoryBackward() }
            },
            navigateForward: {
                quickSwitcherPresentation.dismiss()
                Task { await viewModel.navigateChannelHistoryForward() }
            },
            navigateToPreviousUnread: {
                quickSwitcherPresentation.dismiss()
                Task { await viewModel.navigateToPreviousUnreadChannel() }
            },
            navigateToNextUnread: {
                quickSwitcherPresentation.dismiss()
                Task { await viewModel.navigateToNextUnreadChannel() }
            },
            presentShortcutHelp: {
                quickSwitcherPresentation.dismiss()
                showKeyboardShortcuts = true
            }
        )
    }

    private func activateQuickSwitcherDestination(_ destination: MomoQuickSwitcherDestination) {
        quickSwitcherPresentation.dismiss()
        switch destination {
        case .channel(let id):
            Task { await viewModel.selectChannel(id) }
        case .member(let id):
            selectedProfileMemberID = id
            openDetailPane(.memberProfile)
        }
    }

    private func activateWorkspaceSearchDestination(_ destination: MomoWorkspaceSearchDestination) {
        showWorkspaceSearch = false
        switch destination {
        case .channel(let id):
            Task { await viewModel.selectChannel(id) }
        case .message(let channelID, let messageID):
            Task { await viewModel.focusMessage(messageID, in: channelID) }
        case .member(let id):
            selectedProfileMemberID = id
            openDetailPane(.memberProfile)
        }
    }

    @ViewBuilder
    private func commandPaletteOverlay(copy: MomoWorkspaceCopy) -> some View {
        if quickSwitcherPresentation.isPresented || showWorkspaceSearch {
            ZStack {
                MomoTheme.modalScrim
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {
                        quickSwitcherPresentation.dismiss()
                        showWorkspaceSearch = false
                    }

                Group {
                    if showWorkspaceSearch {
                        MomoWorkspaceSearchView(
                            viewModel: viewModel,
                            copy: copy,
                            activate: activateWorkspaceSearchDestination,
                            dismiss: { showWorkspaceSearch = false }
                        )
                    } else {
                        MomoQuickSwitcherView(
                            viewModel: viewModel,
                            copy: copy,
                            activate: activateQuickSwitcherDestination,
                            dismiss: { quickSwitcherPresentation.dismiss() }
                        )
                    }
                }
                .padding(MomoTheme.QuickSwitcher.edgeInset)
            }
            .accessibilityAddTraits(.isModal)
        }
    }
}

enum MomoChannelActionPolicy {
    static func canOpenSettings(in channel: Channel) -> Bool {
        channel.kind != .dm
    }

    static func canManageMembers(
        in channel: Channel,
        canManageWorkspace: Bool = true
    ) -> Bool {
        canManageWorkspace
            && !channel.isArchived
            && (channel.kind == .publicChannel || channel.kind == .privateChannel)
    }
}

struct MomoChannelSettingsRequest: Identifiable {
    let id = UUID()
    let channelID: ChannelID
    let initialTab: MomoChannelSettingsTab
}

enum MomoWindowChromeLayout {
    static func contentTopInset(windowChromeTopInset: CGFloat) -> CGFloat {
        // NavigationSplitView's detail column follows the same native content
        // layout guide as its sidebar. Reapplying the AppKit measurement here
        // creates an empty strip and vertically desynchronizes inspectors.
        _ = windowChromeTopInset
        return 0
    }

    static func inspectorTopInset(channelHeaderHeight: CGFloat) -> CGFloat {
        max(0, channelHeaderHeight)
    }

    static func sidebarTopInset(windowChromeTopInset: CGFloat) -> CGFloat {
        // NavigationSplitView's native sidebar column already begins below the
        // unified toolbar. Applying NSWindow.contentLayoutRect again creates a
        // second empty titlebar band above the workspace identity.
        _ = windowChromeTopInset
        return 0
    }
}

enum MomoMemberInspectorLayout {
    static func usesAttachedInspector(detailWidth: CGFloat) -> Bool {
        detailWidth >= MomoTheme.MemberInspector.attachedMinimumDetailWidth
    }

    static func blocksTimelineInteraction(
        isPresented: Bool,
        usesAttachedInspector: Bool
    ) -> Bool {
        isPresented && !usesAttachedInspector
    }
}

enum MomoInspectorPresentation {
    case attached
    case overlay

    var cornerRadius: CGFloat {
        switch self {
        case .attached:
            return 0
        case .overlay:
            return MomoTheme.cornerLarge
        }
    }

    var usesElevatedSurfaceChrome: Bool {
        self == .overlay
    }
}

extension View {
    @ViewBuilder
    func momoInspectorSurface(_ presentation: MomoInspectorPresentation) -> some View {
        if presentation.usesElevatedSurfaceChrome {
            momoSurface(.card, cornerRadius: presentation.cornerRadius)
        } else {
            momoFlatSurface(.panel)
        }
    }
}

struct MomoDetailPanePresentationState: Equatable {
    var isPresented = false
    var pane: MomoMacDetailPane = .approvals

    mutating func present(_ pane: MomoMacDetailPane) {
        self.pane = pane
        isPresented = true
    }

    mutating func redirect(to pane: MomoMacDetailPane) {
        self.pane = pane
    }

    mutating func close() {
        isPresented = false
    }
}

enum MomoMacDetailPane: String, CaseIterable, Identifiable {
    case alpha
    case approvals
    case work
    case profile
    case memberProfile
    case settings
    case workspaceSettings
    case downloads
    case updates

    var id: String { rawValue }

    var relatedOperationalPane: MomoMacDetailPane? {
        switch self {
        case .alpha:
            return .approvals
        case .approvals:
            return .alpha
        case .work, .profile, .memberProfile, .settings, .workspaceSettings, .downloads, .updates:
            return nil
        }
    }

    func title(copy: MomoWorkspaceCopy) -> String {
        switch self {
        case .alpha:
            return copy.commandCenter
        case .approvals:
            return copy.approvals
        case .work:
            return copy.workDetailTitle
        case .profile:
            return copy.profile
        case .memberProfile:
            return copy.memberProfile
        case .settings:
            return copy.settings
        case .workspaceSettings:
            return copy.serverSettings
        case .downloads:
            return copy.downloads
        case .updates:
            return copy.updates
        }
    }

    func subtitle(copy: MomoWorkspaceCopy) -> String {
        switch self {
        case .alpha:
            return copy.commandCenterInspectorSubtitle
        case .approvals:
            return copy.approvalsInspectorSubtitle
        case .work:
            return copy.workDetailSubtitle
        case .profile:
            return copy.profileSettingsSubtitle
        case .memberProfile:
            return copy.memberProfileSettingsSubtitle
        case .settings:
            return copy.settingsSubtitle
        case .workspaceSettings:
            return copy.serverSettingsSubtitle
        case .downloads:
            return copy.downloadsSubtitle
        case .updates:
            return copy.updatesSubtitle
        }
    }

    var systemImage: String {
        switch self {
        case .alpha:
            return "list.bullet.clipboard"
        case .approvals:
            return "checkmark.seal"
        case .work:
            return "hammer"
        case .profile:
            return "person.crop.circle"
        case .memberProfile:
            return "person.text.rectangle"
        case .settings:
            return "gearshape"
        case .workspaceSettings:
            return "server.rack"
        case .downloads:
            return "tray.and.arrow.down"
        case .updates:
            return "arrow.down.circle"
        }
    }

    var tint: Color {
        switch self {
        case .alpha:
            return MomoTheme.humanAccent
        case .work:
            return MomoTheme.agentAccent
        case .approvals:
            return MomoTheme.costAmber
        case .profile, .memberProfile, .settings, .workspaceSettings, .downloads, .updates:
            return .secondary
        }
    }
}

// MARK: - Demo bootstrap helper
//
// A convenience that builds a ViewModel on top of a seeded LiveChatBackend so the
// .app follow-up (and previews) can render real content offline. Marked async since
// it connects + loads the roster.

public enum MomoMacDemo {
    /// Build a demo that never consults process environment or reaches a server.
    @MainActor
    public static func makeLocalDemoViewModel() async -> ChatViewModel {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let vm = ChatViewModel(backend: backend)
        await vm.bootstrap(workspace: seed.workspace, accessToken: "demo")
        vm.setChannels(seed.channels)
        if let first = seed.channels.first {
            await vm.selectChannel(first.id)
        }
        return vm
    }

    /// Build + connect a demo ViewModel against an in-memory seeded backend.
    @MainActor
    public static func makeViewModel() async -> ChatViewModel {
        if let config = MomoServerRESTChatBackendConfig.fromEnvironment() {
            return await makeRESTViewModel(config: config)
        }
        return await makeLocalDemoViewModel()
    }

    /// Build + connect a dev ViewModel against local MomoServer REST.
    @MainActor
    public static func makeRESTViewModel(config: MomoServerRESTChatBackendConfig) async -> ChatViewModel {
        let backend = MomoServerRESTChatBackend(config: config)
        let vm = ChatViewModel(chat: backend, agentTransport: backend)
        await vm.bootstrap(workspace: config.workspace, accessToken: config.accessToken ?? "")
        let selected = vm.channels.contains(where: { $0.id == config.defaultChannel })
            ? config.defaultChannel
            : (vm.selectedChannelId ?? vm.channels.first?.id)
        if let selected {
            await vm.selectChannel(selected)
        }
        return vm
    }
}
