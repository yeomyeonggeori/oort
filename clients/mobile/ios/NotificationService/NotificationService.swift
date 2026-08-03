// =============================================================================
// INHERITED SOURCE — DO NOT EDIT HERE, AND DO NOT EDIT THE ORIGINAL EITHER.
//
// Origin: clients/iOS/NotificationService/NotificationService.swift
// Inherited by: goal RN-N1 (ADR-0137 이행 순서 5), 2026-08-03.
//
// Everything below the SENTINEL line is the origin with EXACTLY ONE line
// removed: `import MomoiOSPushKit`. In the frozen kit the push parser was a
// separate SPM module; here PushNotification.swift is compiled into this same
// extension target (see MomoPushShared/PushNotification.swift for why), so the
// symbols are already in scope and the import would not resolve.
//
// `scripts/verify_push_kit_inheritance.sh` applies that same one-line deletion
// to the origin and fails if anything else differs.
//
// ===== SENTINEL: INHERITED BYTES BEGIN =====
import UserNotifications

// @unchecked Sendable: UNNotificationServiceExtension 콜백(didReceive/expire)은 시스템이
// 인스턴스당 직렬로 호출하고, 가변 상태는 finish에서 일괄 해제된다 — 교차 접근 창이 없다.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
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
              let data = MomoKeychainValueStore().data(
                for: MomoPushContract.pushFetchSessionAccount
              ),
              let session = try? JSONDecoder().decode(PushFetchSession.self, from: data)
        else {
            // Fail open: preserve the relay's static placeholder unchanged.
            finish(with: content)
            return
        }

        let resolver = PushNotificationResolver(fetcher: MomoPushRESTFetcher())
        // UNMutableNotificationContent는 non-Sendable — 클로저에는 문자열 fallback만 넘긴다.
        let fallback = PushDisplayContent(title: content.title, body: content.body)
        resolutionTask = Task { [weak self] in
            let display = await resolver.resolve(
                envelope: envelope,
                session: session,
                fallback: fallback
            )
            guard !Task.isCancelled, let self, let updated = self.bestAttemptContent else { return }
            updated.title = display.title
            updated.body = display.body
            self.finish(with: updated)
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
