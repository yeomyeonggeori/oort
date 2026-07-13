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

public struct MomoMacRootView: View {
    @StateObject private var viewModel: ChatViewModel
    @State private var showDetailPane = false
    @State private var detailPane: MomoMacDetailPane = .alpha
    @State private var selectedProfileMemberID: MemberID?
    @State private var splitViewVisibility: NavigationSplitViewVisibility = .all
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoAppearancePreference.appStorageKey) private var appearanceRaw = MomoAppearancePreference.system.rawValue
    private let sessionChrome: MomoSessionChrome?
    private static let layoutAnimation = Animation.timingCurve(0.22, 0.0, 0.0, 1.0, duration: 0.24)
    private static let attachedInspectorMinimumWindowWidth: CGFloat = 1_360
    private static let inspectorWidth: CGFloat = 440

    /// Inject a configured ViewModel (e.g. backed by LiveChatBackend).
    public init(viewModel: @autoclosure @escaping () -> ChatViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.sessionChrome = nil
    }

    /// Host an already-created ViewModel, used by async bootstraps such as the
    /// SwiftPM development app entrypoint.
    public init(existingViewModel viewModel: ChatViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel)
        self.sessionChrome = nil
    }

    init(existingViewModel viewModel: ChatViewModel, sessionChrome: MomoSessionChrome?) {
        _viewModel = StateObject(wrappedValue: viewModel)
        self.sessionChrome = sessionChrome
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
        .background(Color(nsColor: .windowBackgroundColor))
        .preferredColorScheme(appearance.colorScheme)
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
                    .padding(.vertical, 10)
                    .shadow(color: MomoTheme.floatingPanelShadow, radius: 24, x: -12, y: 0)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(Self.layoutAnimation, value: showDetailPane)
    }

    private func sidebar(copy: MomoWorkspaceCopy) -> some View {
        ChannelListView(
            viewModel: viewModel,
            sessionChrome: sessionChrome,
            openCommandCenter: {
                openDetailPane(.alpha)
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
            }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var messageTimeline: some View {
        MessageListView(viewModel: viewModel)
            .frame(minWidth: 0)
    }

    private func detailPaneView(copy: MomoWorkspaceCopy, presentation: MomoInspectorPresentation) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: detailPane.systemImage)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(detailPane == .alpha ? MomoTheme.humanAccent : MomoTheme.costAmber)
                    .frame(width: 32, height: 32)
                    .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(detailPane.title(copy: copy))
                        .font(.headline)
                    Text(detailPane.subtitle(copy: copy))
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
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .background(.primary.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.plain)
                .help(copy.closeDetailPane)
                .momoQuickTooltip(copy.closeDetailPane)
                .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 8)

            if let relatedPane = detailPane.relatedOperationalPane {
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
                .padding(.horizontal, 14)
                .padding(.bottom, 9)
            }

            Divider()

            switch detailPane {
            case .alpha:
                AlphaCommandCenterView(viewModel: viewModel)
            case .approvals:
                ApprovalInboxView(viewModel: viewModel)
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
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: presentation.cornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: presentation.cornerRadius, style: .continuous)
                .stroke(
                    presentation == .overlay ? MomoTheme.subtlePanelBorder : .clear,
                    lineWidth: 1
                )
        }
    }

    private func openDetailPane(_ pane: MomoMacDetailPane) {
        withAnimation(Self.layoutAnimation) {
            detailPane = pane
            showDetailPane = true
        }
    }

    private func toggleDetailPane() {
        withAnimation(Self.layoutAnimation) {
            showDetailPane.toggle()
        }
    }

    private func closeDetailPane() {
        withAnimation(Self.layoutAnimation) {
            showDetailPane = false
        }
    }

    private func overlayInspectorWidth(for detailWidth: CGFloat) -> CGFloat {
        min(Self.inspectorWidth, max(340, detailWidth - 28))
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private var appearance: MomoAppearancePreference {
        MomoAppearancePreference(rawValue: appearanceRaw) ?? .system
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
            return 18
        }
    }
}

private enum MomoMacDetailPane: String, CaseIterable, Identifiable {
    case alpha
    case approvals
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
        case .profile, .memberProfile, .settings, .workspaceSettings, .downloads, .updates:
            return nil
        }
    }

    func title(copy: MomoWorkspaceCopy) -> String {
        switch self {
        case .alpha:
            return copy.commandCenter
        case .approvals:
            return copy.approvals
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
