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
    @State private var columnVisibility: NavigationSplitViewVisibility = .doubleColumn
    @State private var showDetailPane = false
    @State private var detailPane: MomoMacDetailPane = .alpha
    @AppStorage(MomoUILanguage.appStorageKey) private var languageRaw = MomoUILanguage.preferredDefault.rawValue
    @AppStorage(MomoAppearancePreference.appStorageKey) private var appearanceRaw = MomoAppearancePreference.system.rawValue
    private let sessionChrome: MomoSessionChrome?
    private static let layoutAnimation = Animation.timingCurve(0.22, 0.0, 0.0, 1.0, duration: 0.24)

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

        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar(copy: copy)
        } detail: {
            HStack(spacing: 0) {
                messageTimeline
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                if showDetailPane {
                    Divider()
                    detailPaneView(copy: copy)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(Self.layoutAnimation, value: showDetailPane)
        }
        .preferredColorScheme(appearance.colorScheme)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    openDetailPane(.alpha)
                } label: {
                    Label(copy.commandCenter, systemImage: "list.bullet.clipboard")
                }
                .help(copy.showCommandCenter)
                .momoQuickTooltip(copy.showCommandCenter)

                Button {
                    openDetailPane(.approvals)
                } label: {
                    Label(copy.approvals, systemImage: "checkmark.seal")
                }
                .help(copy.showApprovals)
                .momoQuickTooltip(copy.showApprovals)

                Button {
                    toggleDetailPane()
                } label: {
                    Label(copy.detail, systemImage: "sidebar.trailing")
                }
                .help(showDetailPane ? copy.hideDetailPane : copy.showDetailPane)
                .momoQuickTooltip(showDetailPane ? copy.hideDetailPane : copy.showDetailPane)

                languageMenu(copy: copy)
                appearanceMenu(copy: copy)
            }
        }
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
            }
        )
        .frame(minWidth: 304, idealWidth: 328, maxWidth: 380)
    }

    private var messageTimeline: some View {
        MessageListView(viewModel: viewModel)
            .frame(minWidth: 640)
    }

    private func detailPaneView(copy: MomoWorkspaceCopy) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: detailPane.systemImage)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(detailPane == .alpha ? MomoTheme.humanAccent : MomoTheme.costAmber)
                    .frame(width: 32, height: 32)
                    .background(.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    Text(detailPane.title(copy: copy))
                        .font(.system(size: 16, weight: .semibold))
                    Text(detailPane.subtitle(copy: copy))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 8)

                Button {
                    closeDetailPane()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help(copy.closeDetailPane)
                .momoQuickTooltip(copy.closeDetailPane)
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 8)

            Picker("Detail", selection: $detailPane) {
                ForEach(MomoMacDetailPane.allCases) { pane in
                    Label(pane.title(copy: copy), systemImage: pane.systemImage)
                        .tag(pane)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 14)
            .padding(.bottom, 10)

            Divider()

            switch detailPane {
            case .alpha:
                AlphaCommandCenterView(viewModel: viewModel)
            case .approvals:
                ApprovalInboxView(viewModel: viewModel)
            }
        }
        .frame(width: 376)
        .background(.regularMaterial)
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

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func languageMenu(copy: MomoWorkspaceCopy) -> some View {
        Menu {
            ForEach(MomoUILanguage.allCases) { option in
                Button {
                    languageRaw = option.rawValue
                } label: {
                    Label(option.displayName, systemImage: language == option ? "checkmark" : "circle")
                }
            }
        } label: {
            Label(language.displayName, systemImage: "globe")
        }
        .help(copy.languageLabel)
        .momoQuickTooltip(copy.languageLabel)
    }

    private var appearance: MomoAppearancePreference {
        MomoAppearancePreference(rawValue: appearanceRaw) ?? .system
    }

    private func appearanceMenu(copy: MomoWorkspaceCopy) -> some View {
        Menu {
            ForEach(MomoAppearancePreference.allCases) { option in
                Button {
                    appearanceRaw = option.rawValue
                } label: {
                    Label(option.title(copy: copy), systemImage: appearance == option ? "checkmark" : option.systemImage)
                }
            }
        } label: {
            Label(copy.appearanceLabel, systemImage: appearance.systemImage)
        }
        .help(copy.appearanceLabel)
        .momoQuickTooltip(copy.appearanceLabel)
    }
}

private enum MomoMacDetailPane: String, CaseIterable, Identifiable {
    case alpha
    case approvals

    var id: String { rawValue }

    func title(copy: MomoWorkspaceCopy) -> String {
        switch self {
        case .alpha:
            return copy.commandCenter
        case .approvals:
            return copy.approvals
        }
    }

    func subtitle(copy: MomoWorkspaceCopy) -> String {
        switch self {
        case .alpha:
            return copy.commandCenterInspectorSubtitle
        case .approvals:
            return copy.approvalsInspectorSubtitle
        }
    }

    var systemImage: String {
        switch self {
        case .alpha:
            return "list.bullet.clipboard"
        case .approvals:
            return "checkmark.seal"
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
        if let endpoint = config.centrifugoWebSocketURL {
            let tokenProvider = MomoServerRealtimeTokenProvider(
                baseURL: config.baseURL,
                accessTokenProvider: {
                    try await backend.requireAccessToken()
                }
            )
            let transport = SwiftCentrifugeRealtimeSubscriptionTransport(
                endpoint: endpoint,
                workspace: config.workspace,
                tokenProvider: tokenProvider
            )
            await backend.setRealtimeDriver(DefaultRealtimeSubscriptionDriver(transport: transport))
        }
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
