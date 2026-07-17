import MomoiOSKit
import MomoiOSPushKit
import OSLog
import UIKit
import UserNotifications

private let pushLogger = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "app.momo.ios",
    category: "push"
)

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
        let tokenSuffix = deviceToken.suffix(4).map { String(format: "%02x", $0) }.joined()
        pushLogger.info("APNs device token received suffix=\(tokenSuffix, privacy: .public)")
        Task { @MainActor in
            await PushNotificationCoordinator.shared.didRegister(deviceToken: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        pushLogger.error("APNs remote notification registration failed: \(error.localizedDescription, privacy: .public)")
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        Task { @MainActor in
            await PushNotificationCoordinator.shared.retryRegistrationOnForeground()
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
    private var retryOnNextForeground = false
    private var usedForegroundRetry = false
    private var isRegistering = false

    private init() {}

    func activate(session: IOSSession) async {
        activeSession = session
        retryOnNextForeground = false
        usedForegroundRetry = false
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        var authorized = Self.isAuthorized(settings.authorizationStatus)
        if settings.authorizationStatus == .notDetermined {
            authorized = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
        }
        guard authorized else { return }
        pushLogger.info("Requesting APNs remote notification registration")
        UIApplication.shared.registerForRemoteNotifications()
        if let deviceToken {
            await register(deviceToken: deviceToken, session: session, allowsImmediateRetry: true)
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
        retryOnNextForeground = false
        usedForegroundRetry = false
        guard let activeSession else { return }
        await register(deviceToken: deviceToken, session: activeSession, allowsImmediateRetry: true)
    }

    func retryRegistrationOnForeground() async {
        guard retryOnNextForeground, !usedForegroundRetry,
              let deviceToken, let activeSession else { return }
        retryOnNextForeground = false
        usedForegroundRetry = true
        pushLogger.info("Retrying device registration on foreground entry")
        await register(deviceToken: deviceToken, session: activeSession, allowsImmediateRetry: false)
    }

    private func register(
        deviceToken: Data,
        session: IOSSession,
        allowsImmediateRetry: Bool
    ) async {
        guard !isRegistering else { return }
        isRegistering = true
        defer { isRegistering = false }

        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let environment = Self.registrationEnvironment(
            apsEnvironment: Bundle.main.object(forInfoDictionaryKey: "MomoAPNSEnvironment") as? String
        )
        let tokenSuffix = deviceToken.suffix(4).map { String(format: "%02x", $0) }.joined()
        let attemptCount = allowsImmediateRetry ? 2 : 1

        for attempt in 1...attemptCount {
            pushLogger.info(
                "Device registration POST attempt=\(attempt, privacy: .public) env=\(environment.rawValue, privacy: .public) token_suffix=\(tokenSuffix, privacy: .public)"
            )
            do {
                try await client.register(
                    session: session,
                    deviceID: store.loadOrCreateDeviceID(),
                    apnsToken: deviceToken,
                    appBuild: build,
                    environment: environment
                )
                retryOnNextForeground = false
                pushLogger.info("Device registration POST succeeded token_suffix=\(tokenSuffix, privacy: .public)")
                return
            } catch is CancellationError {
                pushLogger.notice("Device registration POST cancelled token_suffix=\(tokenSuffix, privacy: .public)")
                return
            } catch {
                let failure = Self.registrationFailureDescription(error)
                pushLogger.error(
                    "Device registration POST failed attempt=\(attempt, privacy: .public) token_suffix=\(tokenSuffix, privacy: .public): \(failure, privacy: .public)"
                )
            }
        }

        retryOnNextForeground = !usedForegroundRetry
    }

    private static func registrationEnvironment(apsEnvironment: String?) -> APNSRegistrationEnvironment {
        if let environment = APNSRegistrationEnvironment.from(apsEnvironment: apsEnvironment) {
            return environment
        }
#if DEBUG
        pushLogger.notice("Missing aps-environment build value; falling back to sandbox for Debug")
        return .sandbox
#else
        pushLogger.notice("Missing aps-environment build value; falling back to production for Release")
        return .production
#endif
    }

    private static func registrationFailureDescription(_ error: any Error) -> String {
        switch error {
        case SessionError.server(let status, _):
            "server HTTP \(status)"
        case SessionError.transport(_):
            "transport error"
        case SessionError.validation(_):
            "request validation error"
        case SessionError.decoding(_):
            "response decoding error"
        default:
            "unexpected \(String(describing: type(of: error)))"
        }
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
