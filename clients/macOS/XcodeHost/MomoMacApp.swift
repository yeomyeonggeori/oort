import SwiftUI
import MomoMac

@main
struct MomoMacApp: App {
    var body: some Scene {
        WindowGroup("momo") {
            MomoMacHostRoot()
                .frame(minWidth: 980, minHeight: 620)
        }
        .defaultSize(width: 1180, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

private struct MomoMacHostRoot: View {
    @State private var viewModel: ChatViewModel?

    var body: some View {
        Group {
            if let viewModel {
                MomoMacRootView(existingViewModel: viewModel)
            } else {
                ProgressView("Opening momo...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task {
                        await load()
                    }
            }
        }
    }

    @MainActor
    private func load() async {
        guard viewModel == nil else { return }
        viewModel = await MomoMacDemo.makeViewModel()
    }
}
