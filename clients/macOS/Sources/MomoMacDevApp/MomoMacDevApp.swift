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
            SidebarCommands()
        }
    }
}

private struct DevAppRoot: View {
    var body: some View {
        MomoMacSessionRootView()
    }
}
