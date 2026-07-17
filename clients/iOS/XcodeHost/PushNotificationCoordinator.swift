import MomoiOSKit
import MomoiOSPushKit
import UIKit
import UserNotifications

final class MomoiOSAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            Task { @MainActor in
                IOSPushDeepLinkRouter.shared.route(userInfo: userInfo)
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            await PushNotificationCoordinator.shared.didRegister(deviceToken: deviceToken)
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        // non-Sendable 파라미터는 nonisolated 문맥에서 Sendable 값으로 환원 후 hop한다.
        guard let envelope = try? MomoPushParser.parse(
            userInfo: response.notification.request.content.userInfo
        ), let link = IOSPushDeepLink(envelope: envelope) else { return }
        await MainActor.run {
            IOSPushDeepLinkRouter.shared.route(link: link)
        }
    }
}

@MainActor
final class PushNotificationCoordinator: IOSPushLifecycle {
    static let shared = PushNotificationCoordinator()

    private let store = SessionStore.shared
    private let client = MomoPushRegistrationClient()
    private var activeSession: IOSSession?
    private var deviceToken: Data?

    private init() {}

    func activate(session: IOSSession) async {
        activeSession = session
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        var authorized = Self.isAuthorized(settings.authorizationStatus)
        if settings.authorizationStatus == .notDetermined {
            authorized = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
        }
        guard authorized else { return }
        UIApplication.shared.registerForRemoteNotifications()
        if let deviceToken {
            await register(deviceToken: deviceToken, session: session)
        }
    }

    func revoke(session: IOSSession) async {
        try? await client.revoke(session: session, deviceID: store.loadOrCreateDeviceID())
        if activeSession?.workspaceID == session.workspaceID {
            activeSession = nil
        }
    }

    func didRegister(deviceToken: Data) async {
        self.deviceToken = deviceToken
        guard let activeSession else { return }
        await register(deviceToken: deviceToken, session: activeSession)
    }

    private func register(deviceToken: Data, session: IOSSession) async {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        try? await client.register(
            session: session,
            deviceID: store.loadOrCreateDeviceID(),
            apnsToken: deviceToken,
            appBuild: build
        )
    }

    private static func isAuthorized(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined, .denied:
            return false
        @unknown default:
            return false
        }
    }
}
