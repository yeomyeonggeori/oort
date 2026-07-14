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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var detailPanePresentation = MomoDetailPanePresentationState()
    @State private var selectedProfileMemberID: MemberID?
    @State private var selectedWorkRunID: RunID?
    @State private var splitViewVisibility: NavigationSplitViewVisibility = .all
    @State private var quickSwitcherPresentation = MomoQuickSwitcherPresentationState()
    @State private var showKeyboardShortcuts = false
    @State private var showMemberDirectory = false
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoAppearancePreference.appStorageKey) private var appearanceRaw = MomoAppearancePreference.system.rawValue
    @AppStorage(MomoDeveloperModePresentation.developerModeKey) private var developerMode = false
    @AppStorage("momo.server.displayName") private var serverDisplayName = "momo"
    @AppStorage("momo.server.iconText") private var serverIconText = "m"
    @AppStorage("momo.server.iconPath") private var serverIconPath = ""
    @AppStorage("momo.profile.displayName") private var profileDisplayName = ""
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
        onOpenMemberDirectory: MomoMemberDirectoryHook? = nil
    ) {
        _viewModel = StateObject(wrappedValue: viewModel)
        self.sessionChrome = sessionChrome
        self.onOpenMemberDirectory = onOpenMemberDirectory
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
                detailLayout(
                    copy: copy,
                    availableDetailWidth: geometry.size.width,
                    useAttachedInspector: geometry.size.width >= Self.attachedInspectorMinimumWindowWidth
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                workspaceToolbarHeader(copy: copy)
            }
        }
        .momoSurface(.background, cornerRadius: 0, extent: .windowChrome)
        .preferredColorScheme(appearance.colorScheme)
        .focusedSceneValue(\.momoMacCommandActions, commandActions)
        .overlay {
            if quickSwitcherPresentation.isPresented {
                ZStack {
                    MomoTheme.modalScrim
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture {
                            quickSwitcherPresentation.dismiss()
                        }

                    MomoQuickSwitcherView(
                        viewModel: viewModel,
                        copy: copy,
                        activate: activateQuickSwitcherDestination,
                        dismiss: {
                            quickSwitcherPresentation.dismiss()
                        }
                    )
                    .padding(MomoTheme.QuickSwitcher.edgeInset)
                }
                .accessibilityAddTraits(.isModal)
            }
        }
        .sheet(isPresented: $showKeyboardShortcuts) {
            MomoKeyboardShortcutsView(copy: copy)
        }
        .sheet(isPresented: $showMemberDirectory) {
            MemberDirectoryView(viewModel: viewModel)
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
        useAttachedInspector: Bool
    ) -> some View {
        ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                messageTimeline
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                if showDetailPane && useAttachedInspector {
                    Divider()
                    detailPaneView(copy: copy, presentation: .attached)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if showDetailPane && !useAttachedInspector {
                MomoTheme.modalScrim
                    .ignoresSafeArea()
                    .transition(.opacity)
                    .onTapGesture {
                        closeDetailPane()
                    }

                detailPaneView(copy: copy, presentation: .overlay)
                    .frame(width: overlayInspectorWidth(for: availableDetailWidth))
                    .padding(.trailing, 12)
                    .padding(.vertical, 8)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(layoutAnimation, value: showDetailPane)
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
            openDownloads: {
                openDetailPane(.downloads)
            },
            openUpdates: {
                openDetailPane(.updates)
            },
            showsWorkspaceHeader: false
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
            onOpenMemberDirectory: memberDirectoryAction
        )
            .frame(minWidth: 0)
    }

    private var memberDirectoryAction: MomoMemberDirectoryHook {
        MomoMemberDirectoryNavigation.action(
            override: onOpenMemberDirectory,
            presentDirectory: {
                showMemberDirectory = true
            }
        )
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
                ApprovalInboxView(viewModel: viewModel)
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
                MomoProfileSettingsSurface(copy: copy, summary: sessionChrome?.summary)
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
                MomoWorkspaceSettingsSurface(copy: copy)
            case .downloads:
                MomoDownloadsSettingsSurface(copy: copy)
            case .updates:
                MomoUpdateStatusSurface(copy: copy)
            }
        }
        .frame(width: presentation == .attached ? Self.inspectorWidth : nil)
        .momoSurface(
            presentation == .overlay ? .card : .panel,
            cornerRadius: presentation.cornerRadius
        )
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

    private func overlayInspectorWidth(for detailWidth: CGFloat) -> CGFloat {
        min(Self.inspectorWidth, max(340, detailWidth - 28))
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

    private func workspaceToolbarHeader(copy: MomoWorkspaceCopy) -> some View {
        Button {
            openDetailPane(.workspaceSettings)
        } label: {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: MomoTheme.Sidebar.standardSpacing) {
                    workspaceToolbarLogo
                    VStack(alignment: .leading, spacing: MomoTheme.Sidebar.compactSpacing) {
                        Text(serverDisplayName)
                            .font(MomoTheme.Typography.toolbarTitle)
                            .fixedSize()
                        Text(workspaceMemberDisplayName)
                            .font(MomoTheme.Typography.toolbarSupporting)
                            .foregroundStyle(.secondary)
                            .fixedSize()
                    }
                }

                workspaceToolbarLogo
            }
        }
        .buttonStyle(.plain)
        .help("\(serverDisplayName), \(copy.serverSettings)")
        .momoQuickTooltip(copy.serverSettings)
        .accessibilityLabel("\(serverDisplayName), \(copy.serverSettings)")
    }

    private var workspaceToolbarLogo: some View {
        MomoSidebarLogoMark(
            text: serverIconText,
            imagePath: serverIconPath,
            size: MomoTheme.Sidebar.toolbarLogoSize
        )
    }

    private var workspaceMemberDisplayName: String {
        let sessionName = sessionChrome?.summary.memberDisplayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !sessionName.isEmpty { return sessionName }
        let profileName = profileDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return profileName.isEmpty ? "momo" : profileName
    }

    private var commandActions: MomoMacCommandActions {
        MomoMacCommandActions(
            language: language,
            channelCount: viewModel.sidebarChannelOrder.orderedChannels.count,
            canNavigateBackward: viewModel.canNavigateChannelHistoryBackward,
            canNavigateForward: viewModel.canNavigateChannelHistoryForward,
            canNavigateUnreadChannels: viewModel.canNavigateUnreadChannels,
            presentQuickSwitcher: {
                showKeyboardShortcuts = false
                quickSwitcherPresentation.toggle()
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
}

private enum MomoInspectorPresentation {
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
    /// Build + connect a demo ViewModel against an in-memory seeded backend.
    @MainActor
    public static func makeViewModel() async -> ChatViewModel {
        if let config = MomoServerRESTChatBackendConfig.fromEnvironment() {
            return await makeRESTViewModel(config: config)
        }

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
