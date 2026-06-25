import SwiftUI
import MomoMac

@main
struct MomoMacDevApp: App {
    var body: some Scene {
        WindowGroup("momo") {
            DevAppRoot()
                .frame(minWidth: 980, minHeight: 620)
        }
        .defaultSize(width: 1180, height: 760)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

private struct DevAppRoot: View {
    @State private var viewModel: ChatViewModel?

    var body: some View {
        Group {
            if let viewModel {
                MomoMacRootView(existingViewModel: viewModel)
            } else {
                ProgressView("Opening momo...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task {
                        await loadDemo()
                    }
            }
        }
    }

    @MainActor
    private func loadDemo() async {
        guard viewModel == nil else { return }
        viewModel = await MomoMacDemo.makeViewModel()
    }
}
