import MomoiOSPushKit
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var resolutionTask: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            finish(with: request.content)
            return
        }
        bestAttemptContent = content
        guard let envelope = try? MomoPushParser.parse(userInfo: request.content.userInfo),
              let defaults = UserDefaults(suiteName: MomoPushContract.appGroupIdentifier),
              let data = defaults.data(forKey: MomoPushContract.sessionKey),
              let session = try? JSONDecoder().decode(PushFetchSession.self, from: data)
        else {
            // Fail open: preserve the relay's static placeholder unchanged.
            finish(with: content)
            return
        }

        let resolver = PushNotificationResolver(fetcher: MomoPushRESTFetcher())
        resolutionTask = Task { [weak self] in
            let display = await resolver.resolve(
                envelope: envelope,
                session: session,
                fallback: PushDisplayContent(title: content.title, body: content.body)
            )
            guard !Task.isCancelled, let self, let updated = bestAttemptContent else { return }
            updated.title = display.title
            updated.body = display.body
            finish(with: updated)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        resolutionTask?.cancel()
        if let bestAttemptContent {
            finish(with: bestAttemptContent)
        }
    }

    private func finish(with content: UNNotificationContent) {
        let handler = contentHandler
        contentHandler = nil
        bestAttemptContent = nil
        resolutionTask = nil
        handler?(content)
    }
}
