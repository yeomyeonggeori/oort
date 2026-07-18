import AppKit
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

enum MomoMacPrimaryDestination {
    case channel
    case plugins
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
    @State private var windowChromeMetrics = MomoWindowChromeMetrics.zero
    @State private var quickSwitcherPresentation = MomoQuickSwitcherPresentationState()
    @State private var showKeyboardShortcuts = false
    @State private var showWorkspaceSearch = false
    @State private var channelSettingsRequest: MomoChannelSettingsRequest?
    @State private var showMemberInspector = true
    @State private var memberInspectorAudience = MomoMemberInspectorAudience.channel
    @State private var composerFocusRequest: UInt64 = 0
    @State private var showDownloadsPanel = false
    @State private var primaryDestination = MomoMacPrimaryDestination.channel
    @State private var transientSidebarWidth: CGFloat?
    @AppStorage("momo.workspace.sidebar.width") private var preferredSidebarWidth = MomoTheme.Sidebar.idealWidth
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
        initialSplitViewVisibility: NavigationSplitViewVisibility = .all,
        initialPrimaryDestination: MomoMacPrimaryDestination = .channel
    ) {
        _viewModel = StateObject(wrappedValue: viewModel)
        _splitViewVisibility = State(initialValue: initialSplitViewVisibility)
        _primaryDestination = State(initialValue: initialPrimaryDestination)
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

        windowShell(copy: copy)
        // The three surfaces own the window from its top edge. AppKit keeps
        // only the traffic lights; each pane owns its own top controls.
        .ignoresSafeArea(.container, edges: .top)
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
        .background(
            MomoTheme.Surface.style(.panel, colorScheme: colorScheme).fill
                .ignoresSafeArea()
        )
        .preferredColorScheme(appearance.colorScheme)
        .focusedSceneValue(\.momoMacCommandActions, commandActions)
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
        .onChange(of: viewModel.selectedChannelId) { _, _ in
            primaryDestination = .channel
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

    private func windowShell(copy: MomoWorkspaceCopy) -> some View {
        GeometryReader { geometry in
            let requestedSidebarWidth = transientSidebarWidth ?? CGFloat(preferredSidebarWidth)
            let sidebarWidth = splitViewVisibility == .detailOnly
                ? 0
                : MomoWindowChromeLayout.sidebarWidth(
                    preferredWidth: requestedSidebarWidth,
                    availableWidth: geometry.size.width
                )
            let detailWidth = max(0, geometry.size.width - sidebarWidth)
            HStack(spacing: 0) {
                if sidebarWidth > 0 {
                    sidebar(copy: copy)
                        .frame(width: sidebarWidth)
                        .overlay(alignment: .topTrailing) {
                            sidebarChromeControls(copy: copy)
                                .frame(
                                    height: MomoWindowChromeLayout.controlBandHeight
                                )
                                .padding(.trailing, 12)
                        }
                        .overlay(alignment: .trailing) {
                            // NavigationSplitView cannot give all three surfaces one
                            // titlebar-spanning shell without adding duplicate dividers.
                            MomoSidebarResizeHandle(
                                width: sidebarWidth,
                                availableWidth: geometry.size.width,
                                onResize: { transientSidebarWidth = $0 },
                                onCommit: {
                                    preferredSidebarWidth = Double($0)
                                    transientSidebarWidth = nil
                                },
                                accessibilityLabel: copy.resizeSidebar,
                                accessibilityValue: copy.sidebarWidthValue(sidebarWidth)
                            )
                        }
                        .transition(.move(edge: .leading))
                }

                detailLayout(
                    copy: copy,
                    availableDetailWidth: detailWidth,
                    useAttachedInspector: detailWidth >= Self.attachedInspectorMinimumWindowWidth,
                    useAttachedMemberInspector: MomoMemberInspectorLayout.usesAttachedInspector(
                        detailWidth: detailWidth
                    ),
                    showsSidebarToggle: sidebarWidth == 0
                )
                .frame(width: detailWidth)
            }
            .frame(
                width: geometry.size.width,
                height: geometry.size.height,
                alignment: .top
            )
        }
    }

    private func detailLayout(
        copy: MomoWorkspaceCopy,
        availableDetailWidth: CGFloat,
        useAttachedInspector: Bool,
        useAttachedMemberInspector: Bool,
        showsSidebarToggle: Bool
    ) -> some View {
        let showsMemberInspector = showMemberInspector && !showDetailPane
        let blocksTimelineForMemberOverlay = MomoMemberInspectorLayout.blocksTimelineInteraction(
            isPresented: showsMemberInspector,
            usesAttachedInspector: useAttachedMemberInspector
        )
        let blocksTimelineForDetailOverlay = showDetailPane && !useAttachedInspector
        let blocksTimelineInteraction = blocksTimelineForMemberOverlay || blocksTimelineForDetailOverlay

        return ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                ZStack {
                    MomoTheme.Surface.style(.background, colorScheme: colorScheme).fill

                    primaryContent(copy: copy)
                        .environment(
                            \.momoCenterHeaderLeadingInset,
                            MomoWindowChromeLayout.centerHeaderLeadingInset(
                                sidebarVisible: !showsSidebarToggle
                            )
                        )
                        .allowsHitTesting(!blocksTimelineInteraction)
                        .accessibilityHidden(blocksTimelineInteraction)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .topTrailing) {
                    detailChromeControls(
                        copy: copy,
                        showsSidebarToggle: showsSidebarToggle
                    )
                    .frame(
                        height: MomoWindowChromeLayout.controlBandHeight
                    )
                }
                .overlay(alignment: .topTrailing) {
                    if showDownloadsPanel {
                        // A system popover can leave the app window near screen edges.
                        // This bounded panel keeps download controls inside the center pane.
                        MomoDownloadsPanelView(
                            copy: copy,
                            onDismiss: { setDownloadsPanelPresented(false) }
                        )
                        .padding(.top, MomoWindowChromeLayout.controlBandHeight + 8)
                        .padding(.trailing, 12)
                    }
                }

                if showDetailPane && useAttachedInspector {
                    detailPaneView(copy: copy, presentation: .attached)
                    .frame(maxHeight: .infinity)
                    .frame(width: Self.inspectorWidth)
                    .background(MomoTheme.Surface.style(.panel, colorScheme: colorScheme).fill)
                    .overlay(alignment: .leading) {
                        MomoPaneDivider()
                    }
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                } else if showsMemberInspector && useAttachedMemberInspector {
                    memberInspectorView(copy: copy, isAttached: true)
                        .frame(width: MomoTheme.MemberInspector.attachedWidth)
                        .background(MomoTheme.Surface.style(.panel, colorScheme: colorScheme).fill)
                        .overlay(alignment: .leading) {
                            MomoPaneDivider()
                        }
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if showDetailPane && !useAttachedInspector {
                GeometryReader { inspectorGeometry in
                    ZStack(alignment: .trailing) {
                        MomoTheme.modalScrim
                            .transition(.opacity)
                            .contentShape(Rectangle())
                            .accessibilityHidden(true)
                            .onTapGesture {
                                closeDetailPane()
                            }

                        detailPaneView(copy: copy, presentation: .attached)
                            .frame(maxHeight: .infinity)
                            .frame(width: overlayInspectorWidth(for: availableDetailWidth))
                            .frame(maxHeight: .infinity)
                            .background(
                                MomoTheme.Surface.style(.panel, colorScheme: colorScheme).fill
                            )
                            .overlay(alignment: .leading) {
                                MomoPaneDivider()
                            }
                            .accessibilityAddTraits(.isModal)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                    .frame(width: inspectorGeometry.size.width, height: inspectorGeometry.size.height)
                }
            } else if showsMemberInspector && !useAttachedMemberInspector {
                GeometryReader { inspectorGeometry in
                    ZStack(alignment: .trailing) {
                        MomoTheme.modalScrim
                            .transition(.opacity)
                            .contentShape(Rectangle())
                            .accessibilityHidden(true)
                            .onTapGesture {
                                closeMemberInspector()
                            }

                        memberInspectorView(copy: copy, isAttached: false)
                            .frame(maxHeight: .infinity)
                            .frame(width: memberInspectorOverlayWidth(for: availableDetailWidth))
                            .frame(maxHeight: .infinity)
                            .background(
                                MomoTheme.Surface.style(.panel, colorScheme: colorScheme).fill
                            )
                            .overlay(alignment: .leading) {
                                MomoPaneDivider()
                            }
                            .accessibilityAddTraits(.isModal)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                    .frame(width: inspectorGeometry.size.width, height: inspectorGeometry.size.height)
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
            openPluginMarketplace: {
                openPluginMarketplace()
            },
            onChannelSelected: { _ in
                withAnimation(layoutAnimation) {
                    primaryDestination = .channel
                }
            },
            isPluginMarketplaceActive: primaryDestination == .plugins,
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
            onOpenPluginMarketplace: {
                openPluginMarketplace()
            }
        )
            .frame(minWidth: 0)
    }

    @ViewBuilder
    private func primaryContent(copy: MomoWorkspaceCopy) -> some View {
        switch primaryDestination {
        case .channel:
            messageTimeline
        case .plugins:
            MomoPluginMarketplaceView(
                language: language,
                serverIdentity: sessionChrome?.summary.serverURLString,
                workspaceID: viewModel.workspaceId,
                memberID: viewModel.currentNavigationMemberID,
                onClose: {
                    primaryDestination = .channel
                }
            )
        }
    }

    private func openPluginMarketplace() {
        withAnimation(layoutAnimation) {
            detailPanePresentation.close()
            showMemberInspector = false
            primaryDestination = .plugins
        }
    }

    private func sidebarChromeControls(copy: MomoWorkspaceCopy) -> some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            sidebarToggleButton(copy: copy)
        }
    }

    private func detailChromeControls(
        copy: MomoWorkspaceCopy,
        showsSidebarToggle: Bool
    ) -> some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)

            if showsSidebarToggle {
                sidebarToggleButton(copy: copy)
            }

            Button {
                quickSwitcherPresentation.dismiss()
                showWorkspaceSearch.toggle()
            } label: {
                Label(copy.workspaceSearch, systemImage: "magnifyingglass")
                    .labelStyle(.iconOnly)
                    .frame(
                        width: MomoTheme.ChannelHeader.actionSize,
                        height: MomoTheme.ChannelHeader.actionSize
                    )
                    .contentShape(Rectangle())
            }
            .help(copy.workspaceSearch)
            .momoQuickTooltip(copy.workspaceSearch)
            .accessibilityLabel(copy.workspaceSearch)
            .accessibilityIdentifier("workspace-search-entry")

            Button {
                setDownloadsPanelPresented(!showDownloadsPanel)
            } label: {
                Label(copy.appDownloads, systemImage: "arrow.down.circle")
                    .labelStyle(.iconOnly)
                    .frame(
                        width: MomoTheme.ChannelHeader.actionSize,
                        height: MomoTheme.ChannelHeader.actionSize
                    )
                    .contentShape(Rectangle())
            }
            .help(copy.appDownloads)
            .momoQuickTooltip(copy.appDownloads)
            .accessibilityLabel(copy.appDownloads)
            .accessibilityHint(copy.downloadsScopeNote)
            .accessibilityIdentifier("app-downloads-entry")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
    }

    private func sidebarToggleButton(copy: MomoWorkspaceCopy) -> some View {
        Button {
            toggleSidebar()
        } label: {
            Label(copy.toggleSidebar, systemImage: "sidebar.leading")
                .labelStyle(.iconOnly)
                .frame(
                    width: MomoTheme.ChannelHeader.actionSize,
                    height: MomoTheme.ChannelHeader.actionSize
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(copy.toggleSidebar)
        .momoQuickTooltip(copy.toggleSidebar)
        .accessibilityLabel(copy.toggleSidebar)
        .accessibilityIdentifier("sidebar-toggle")
    }

    private func setDownloadsPanelPresented(_ isPresented: Bool) {
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            showDownloadsPanel = isPresented
        }
    }

    private func toggleSidebar() {
        withAnimation(layoutAnimation) {
            splitViewVisibility = splitViewVisibility == .detailOnly ? .all : .detailOnly
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
            // Narrow windows keep the inspector modal, but the surface remains a
            // flat, full-height pane instead of turning into a floating card.
            presentation: .attached
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
            .padding(.top, 16)
            .padding(.bottom, 12)
            .frame(
                minHeight: MomoWindowChromeLayout.integratedHeaderHeight
            )

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
            toggleSidebar: toggleSidebar,
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
                setDownloadsPanelPresented(true)
            },
            selectChannel: { number in
                quickSwitcherPresentation.dismiss()
                activateChannelSurface()
                Task { await viewModel.selectChannel(shortcutNumber: number) }
            },
            navigateBackward: {
                quickSwitcherPresentation.dismiss()
                activateChannelSurface()
                Task { await viewModel.navigateChannelHistoryBackward() }
            },
            navigateForward: {
                quickSwitcherPresentation.dismiss()
                activateChannelSurface()
                Task { await viewModel.navigateChannelHistoryForward() }
            },
            navigateToPreviousUnread: {
                quickSwitcherPresentation.dismiss()
                activateChannelSurface()
                Task { await viewModel.navigateToPreviousUnreadChannel() }
            },
            navigateToNextUnread: {
                quickSwitcherPresentation.dismiss()
                activateChannelSurface()
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
            activateChannelSurface()
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
            activateChannelSurface()
            Task { await viewModel.selectChannel(id) }
        case .message(let channelID, let messageID):
            activateChannelSurface()
            Task { await viewModel.focusMessage(messageID, in: channelID) }
        case .member(let id):
            selectedProfileMemberID = id
            openDetailPane(.memberProfile)
        }
    }

    private func activateChannelSurface() {
        withAnimation(layoutAnimation) {
            primaryDestination = .channel
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
    static let minimumControlBandHeight = MomoTheme.WindowChrome.minimumControlBandHeight
    static let centerChromeControlsReservedWidth = MomoTheme.WindowChrome.centerControlsReservedWidth

    /// Center and inspector headers occupy one stable titlebar row. The measured
    /// AppKit inset is only a traffic-light exclusion for sidebar content; using
    /// it as a row height makes headers expand when macOS reports content layout
    /// coordinates instead of the physical titlebar height.
    static let integratedHeaderHeight = max(
        MomoTheme.ChannelHeader.minimumHeight,
        minimumControlBandHeight
    )
    static let controlBandHeight = integratedHeaderHeight
    static let collapsedCenterLeadingInset: CGFloat = 112
    static let sidebarHeaderLeadingInset: CGFloat = 112
    static let sidebarHeaderTrailingInset: CGFloat = 44

    static func shellTopInset(windowChromeTopInset: CGFloat) -> CGFloat {
        max(0, windowChromeTopInset)
    }

    static func centerHeaderLeadingInset(sidebarVisible: Bool) -> CGFloat {
        sidebarVisible ? 0 : collapsedCenterLeadingInset
    }

    static let minimumDetailWidth: CGFloat = 560

    static func sidebarWidth(
        preferredWidth: CGFloat = MomoTheme.Sidebar.idealWidth,
        availableWidth: CGFloat
    ) -> CGFloat {
        let availableMaximum = max(
            MomoTheme.Sidebar.minimumWidth,
            availableWidth - minimumDetailWidth
        )
        let maximumWidth = min(MomoTheme.Sidebar.maximumWidth, availableMaximum)
        return min(maximumWidth, max(MomoTheme.Sidebar.minimumWidth, preferredWidth))
    }
}

private struct MomoSidebarResizeHandle: View {
    let width: CGFloat
    let availableWidth: CGFloat
    let onResize: (CGFloat) -> Void
    let onCommit: (CGFloat) -> Void
    let accessibilityLabel: String
    let accessibilityValue: String
    @State private var dragOrigin: CGFloat?
    @FocusState private var isFocused: Bool

    private let adjustmentStep: CGFloat = 16

    var body: some View {
        ZStack(alignment: .trailing) {
            Color.clear
                .frame(width: 8)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            let origin = dragOrigin ?? width
                            if dragOrigin == nil {
                                dragOrigin = origin
                            }
                            onResize(MomoWindowChromeLayout.sidebarWidth(
                                preferredWidth: origin + value.translation.width,
                                availableWidth: availableWidth
                            ))
                        }
                        .onEnded { value in
                            let origin = dragOrigin ?? width
                            onCommit(MomoWindowChromeLayout.sidebarWidth(
                                preferredWidth: origin + value.translation.width,
                                availableWidth: availableWidth
                            ))
                            dragOrigin = nil
                        }
                )
                .onHover { isHovered in
                    if isHovered {
                        NSCursor.resizeLeftRight.set()
                    } else {
                        NSCursor.arrow.set()
                    }
                }
            MomoPaneDivider()
        }
        .frame(width: 8)
        .contentShape(Rectangle())
        .focusable()
        .focused($isFocused)
        .onMoveCommand { direction in
            switch direction {
            case .left:
                adjustWidth(by: -adjustmentStep)
            case .right:
                adjustWidth(by: adjustmentStep)
            default:
                break
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(accessibilityValue)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment:
                adjustWidth(by: adjustmentStep)
            case .decrement:
                adjustWidth(by: -adjustmentStep)
            @unknown default:
                break
            }
        }
        .help(accessibilityLabel)
    }

    private func adjustWidth(by delta: CGFloat) {
        onCommit(MomoWindowChromeLayout.sidebarWidth(
            preferredWidth: width + delta,
            availableWidth: availableWidth
        ))
    }
}

private struct MomoPaneDivider: View {
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Rectangle()
            .fill(MomoTheme.subtleBorder)
            .frame(width: 1 / max(1, displayScale))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
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

    var cornerRadius: CGFloat {
        0
    }

    var usesElevatedSurfaceChrome: Bool {
        false
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
