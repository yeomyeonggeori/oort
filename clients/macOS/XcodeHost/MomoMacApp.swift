import SwiftUI
import MomoMac

@main
struct MomoMacApp: App {
    var body: some Scene {
        WindowGroup("oort") {
            MomoMacHostRoot()
        }
        .defaultSize(width: 1180, height: 760)
        .momoWindowChromeStyle()
        .commands {
            CommandGroup(replacing: .newItem) {}
            MomoMacCommands()
        }
    }
}

private struct MomoMacHostRoot: View {
    var body: some View {
        MomoMacSessionRootView()
    }
}
