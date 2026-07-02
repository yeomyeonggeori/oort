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
    private let sessionChrome: MomoSessionChrome?

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

        Group {
            if showDetailPane {
                threePaneLayout(copy: copy)
            } else {
                twoPaneLayout(copy: copy)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: showDetailPane)
        .toolbar {
            ToolbarItem {
                Button {
                    openDetailPane(.alpha)
                } label: {
                    Label(copy.commandCenter, systemImage: "list.bullet.clipboard")
                }
                .help(copy.showCommandCenter)
            }

            ToolbarItem {
                Button {
                    openDetailPane(.approvals)
                } label: {
                    Label(copy.approvals, systemImage: "checkmark.seal")
                }
                .help(copy.showApprovals)
            }

            ToolbarItem {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        showDetailPane.toggle()
                        columnVisibility = showDetailPane ? .all : .doubleColumn
                    }
                } label: {
                    Label(copy.detail, systemImage: "sidebar.trailing")
                }
                .help(showDetailPane ? copy.hideDetailPane : copy.showDetailPane)
            }

            ToolbarItem {
                languageMenu(copy: copy)
            }
        }
    }

    private func twoPaneLayout(copy: MomoWorkspaceCopy) -> some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar(copy: copy)
        } detail: {
            messageTimeline
        }
    }

    private func threePaneLayout(copy: MomoWorkspaceCopy) -> some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar(copy: copy)
        } content: {
            messageTimeline
        } detail: {
            detailPaneView(copy: copy)
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
        .frame(minWidth: 292, idealWidth: 320, maxWidth: 380)
    }

    private var messageTimeline: some View {
        MessageListView(viewModel: viewModel)
            .frame(minWidth: 640)
    }

    private func detailPaneView(copy: MomoWorkspaceCopy) -> some View {
        VStack(spacing: 0) {
            Picker("Detail", selection: $detailPane) {
                ForEach(MomoMacDetailPane.allCases) { pane in
                    Label(pane.title(copy: copy), systemImage: pane.systemImage)
                        .tag(pane)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(10)

            Divider()

            switch detailPane {
            case .alpha:
                AlphaCommandCenterView(viewModel: viewModel)
            case .approvals:
                ApprovalInboxView(viewModel: viewModel)
            }
        }
        .frame(minWidth: 320, idealWidth: 360)
    }

    private func openDetailPane(_ pane: MomoMacDetailPane) {
        withAnimation(.easeInOut(duration: 0.18)) {
            detailPane = pane
            showDetailPane = true
            columnVisibility = .all
        }
    }

    private var language: MomoUILanguage {
        MomoUILanguage(rawValue: languageRaw) ?? .preferredDefault
    }

    private func languageMenu(copy: MomoWorkspaceCopy) -> some View {
        Menu {
            Picker(copy.languageLabel, selection: $languageRaw) {
                ForEach(MomoUILanguage.allCases) { option in
                    Text(option.displayName).tag(option.rawValue)
                }
            }
        } label: {
            Label(language.displayName, systemImage: "globe")
        }
        .help(copy.languageLabel)
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
