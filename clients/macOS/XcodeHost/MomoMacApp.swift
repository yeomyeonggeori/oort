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
        .windowToolbarStyle(.unified)
        .commands {
            CommandGroup(replacing: .newItem) {}
            SidebarCommands()
            MomoMacCommands()
        }
    }
}

private struct MomoMacHostRoot: View {
    var body: some View {
        MomoMacSessionRootView()
    }
}
