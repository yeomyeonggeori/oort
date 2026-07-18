import MomoiOSKit
import SwiftUI

@main
struct MomoiOSApp: App {
    @UIApplicationDelegateAdaptor(MomoiOSAppDelegate.self) private var appDelegate
    @State private var model = MomoiOSAppModel(pushLifecycle: PushNotificationCoordinator.shared)

    var body: some Scene {
        WindowGroup {
            MomoiOSRootView(model: model, deepLinkRouter: .shared)
        }
    }
}
