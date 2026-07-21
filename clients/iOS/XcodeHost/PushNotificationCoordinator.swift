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
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        IOSNotificationCategoryRegistry.register(center: center)
        if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            Task { @MainActor in
                IOSPushDeepLinkRouter.shared.route(userInfo: userInfo)
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        pushLogger.info("APNs device token received")
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
            IOSNotificationCategoryRegistry.register()
            await PushNotificationCoordinator.shared.retryRegistrationOnForeground()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        guard let envelope = try? MomoPushParser.parse(
            userInfo: notification.request.content.userInfo
        ) else { return [.banner, .list, .sound] }
        await MainActor.run {
            UIApplication.shared.applicationIconBadgeNumber = envelope.badge
        }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let envelope = try? MomoPushParser.parse(
            userInfo: response.notification.request.content.userInfo
        ), let link = IOSPushDeepLink(envelope: envelope) else { return }

        await MainActor.run {
            UIApplication.shared.applicationIconBadgeNumber = envelope.badge
        }

        switch response.actionIdentifier {
        case UNNotificationDismissActionIdentifier:
            return
        case UNNotificationDefaultActionIdentifier:
            await MainActor.run { IOSPushDeepLinkRouter.shared.route(link: link) }
        case MomoPushActionIdentifier.quickReply:
            guard let textResponse = response as? UNTextInputNotificationResponse else { return }
            let succeeded = await PushNotificationCoordinator.shared.handle(
                action: .quickReply(textResponse.userText),
                envelope: envelope
            )
            if !succeeded {
                await MainActor.run { IOSPushDeepLinkRouter.shared.route(link: link) }
            }
        case MomoPushActionIdentifier.approve:
            let succeeded = await PushNotificationCoordinator.shared.handle(
                action: .decideApproval(true),
                envelope: envelope
            )
            if !succeeded {
                await MainActor.run { IOSPushDeepLinkRouter.shared.route(link: link) }
            }
        case MomoPushActionIdentifier.reject:
            let succeeded = await PushNotificationCoordinator.shared.handle(
                action: .decideApproval(false),
                envelope: envelope
            )
            if !succeeded {
                await MainActor.run { IOSPushDeepLinkRouter.shared.route(link: link) }
            }
        default:
            await MainActor.run { IOSPushDeepLinkRouter.shared.route(link: link) }
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
        IOSNotificationCategoryRegistry.register()
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

    func handle(action: IOSPushActionIntent, envelope: MomoPushEnvelope) async -> Bool {
        guard let session = activeSession ?? store.loadSession(),
              session.workspaceID.description.lowercased() == envelope.workspaceID.lowercased()
        else { return false }
        do {
            try await IOSPushActionExecutor(
                backend: MomoServerConversationClient(authenticated: session)
            ).perform(action, envelope: envelope, signedInWorkspaceID: session.workspaceID)
            pushLogger.info("Notification action completed")
            return true
        } catch is CancellationError {
            return false
        } catch {
            pushLogger.error("Notification action failed")
            return false
        }
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
        let attemptCount = allowsImmediateRetry ? 2 : 1

        for attempt in 1...attemptCount {
            pushLogger.info(
                "Device registration POST attempt=\(attempt, privacy: .public) env=\(environment.rawValue, privacy: .public)"
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
                pushLogger.info("Device registration POST succeeded")
                return
            } catch is CancellationError {
                pushLogger.notice("Device registration POST cancelled")
                return
            } catch {
                let failure = Self.registrationFailureDescription(error)
                pushLogger.error(
                    "Device registration POST failed attempt=\(attempt, privacy: .public): \(failure, privacy: .public)"
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
