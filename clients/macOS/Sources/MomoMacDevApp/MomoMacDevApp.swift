import SwiftUI
import MomoMac

@main
struct MomoMacDevApp: App {
    init() {
        MomoWindowDoubleClickZoom.install()
    }

    var body: some Scene {
        WindowGroup("momo") {
            DevAppRoot()
        }
        .defaultSize(width: 1180, height: 760)
        .momoWindowChromeStyle()
        .commands {
            CommandGroup(replacing: .newItem) {}
            MomoMacCommands()
        }
    }
}

private struct DevAppRoot: View {
    var body: some View {
        MomoMacSessionRootView()
    }
}
