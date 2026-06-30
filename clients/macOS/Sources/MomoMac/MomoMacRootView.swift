import SwiftUI
import MomoCore

// MARK: - MomoMacRootView
//
// The top-level macOS layout: a 3-pane NavigationSplitView wiring together the
// channel sidebar, the seq-ordered message timeline, and the approval inbox
// (experience C) as an inspector pane. This is the composition root the .app
// follow-up ticket will host inside a `WindowGroup` (Info.plist / Xcode target).
//
// All panes drive off a single ChatViewModel bound to the MomoCore contracts.

public struct MomoMacRootView: View {
    @StateObject private var viewModel: ChatViewModel
    @State private var showApprovals = true

    /// Inject a configured ViewModel (e.g. backed by LiveChatBackend).
    public init(viewModel: @autoclosure @escaping () -> ChatViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    /// Host an already-created ViewModel, used by async bootstraps such as the
    /// SwiftPM development app entrypoint.
    public init(existingViewModel viewModel: ChatViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel)
    }

    public var body: some View {
        NavigationSplitView {
            ChannelListView(viewModel: viewModel)
                .frame(minWidth: 200)
        } content: {
            MessageListView(viewModel: viewModel)
                .frame(minWidth: 360)
        } detail: {
            if showApprovals {
                ApprovalInboxView(viewModel: viewModel)
                    .frame(minWidth: 280)
            } else {
                Color.clear
            }
        }
        .toolbar {
            ToolbarItem {
                Button {
                    showApprovals.toggle()
                } label: {
                    Label("Approvals", systemImage: "checkmark.seal")
                }
            }
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
