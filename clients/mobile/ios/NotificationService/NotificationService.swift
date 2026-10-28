// =============================================================================
// INHERITED SOURCE — the origin is GONE: `clients/iOS` was deleted 2026-08-10 (W-S1, #1215), so this file
// is now the ONLY copy and `scripts/verify_push_kit_inheritance.sh` SKIPs it. Edit it here, and keep the
// SENTINEL line below (the verifier still requires it).
//
// Edited after the inheritance, on purpose (each is a behaviour the frozen kit never had):
//   - #4316: the body it writes is dressed as a communication notification — the sender's round photo with
//     the app icon small at its corner, the conversation's name — by `PushPresentationAssembler` (what to
//     say) and `PushCommunicationPresenter` (donate, apply). Every earlier rule is kept as it was: the
//     approval buttons come off first and come back only for a notification that says what it is
//     (ADR-0204 D7), a push it cannot read stays the relay's placeholder, and the whole thing still ends
//     in one `contentHandler` call. A single lock now guards that call: the donation finishes on a system
//     queue while the system's own expiry call arrives on another.
//
// Origin: clients/iOS/NotificationService/NotificationService.swift
// Inherited by: goal RN-N1 (ADR-0137 이행 순서 5), 2026-08-03.
//
// Everything below the SENTINEL line WAS the origin with EXACTLY ONE line removed: `import MomoiOSPushKit`.
// In the frozen kit the push parser was a separate SPM module; here PushNotification.swift is compiled into
// this same extension target (see MomoPushShared/PushNotification.swift for why), so the symbols are already
// in scope and the import would not resolve.
//
// ===== SENTINEL: INHERITED BYTES BEGIN =====
import UserNotifications

// @unchecked Sendable: UNNotificationServiceExtension 콜백(didReceive/expire)은 시스템이
// 인스턴스당 직렬로 호출하지만, 사진 기부(donate)의 완료는 시스템 큐에서 돌아온다. 그래서 가변
// 상태는 `lock` 안에서만 읽고 쓰고, `finish` 는 어느 쪽이 먼저 오든 한 번만 handler 를 부른다.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    /// 시스템이 확장에 주는 시간은 약 30초다. 사진을 받는 읽기는 이 안에서 남은 시간을 보고 건너뛴다.
    private static let budget: TimeInterval = 25

    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var resolutionTask: Task<Void, Never>?
    private let presenter = PushCommunicationPresenter()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        lock.lock()
        self.contentHandler = contentHandler
        lock.unlock()
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            finish(with: request.content)
            return
        }
        lock.lock()
        bestAttemptContent = content
        lock.unlock()
        // ADR-0204 D7: 아래 어느 길로든 본문을 못 채우고 끝나면 승인 버튼을 뗀다(fail-open 도 마찬가지).
        content.categoryIdentifier = MomoPushCategoryDemotion.categoryIdentifier(
            current: content.categoryIdentifier, resolved: false)
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

        let container = MomoPushPresentationContainer.appGroup()
        let assembler = PushPresentationAssembler(
            resolver: PushNotificationResolver(fetcher: MomoPushRESTFetcher()),
            container: container,
            downloader: PushAvatarURLSessionDownloader())
        // UNMutableNotificationContent는 non-Sendable — 클로저에는 문자열 fallback만 넘긴다.
        let fallback = PushDisplayContent(title: content.title, body: content.body)
        let originalCategory = request.content.categoryIdentifier
        let startedAt = Date()
        let task = Task { [weak self] in
            let result = await assembler.assemble(
                envelope: envelope,
                session: session,
                fallback: fallback,
                remaining: Self.budget - Date().timeIntervalSince(startedAt)
            )
            guard !Task.isCancelled, let self, let updated = self.currentContent() else { return }
            let display = result.presentation.display
            updated.title = display.title
            updated.body = display.body
            // 채워졌을 때만 원래 카테고리(버튼)로 돌려놓는다.
            let resolved = display.title != fallback.title || display.body != fallback.body
            if resolved {
                updated.categoryIdentifier = originalCategory
            }
            // 미리보기·보낸 사람 표시를 끈 알림은 무엇인지 말하지 않는다: 버튼을 되돌린 뒤에도 다시 뗀다
            // (서버가 승인 카테고리를 메시지 이유와 짝지어 보낸 경우까지 — ADR-0204 D7).
            if !result.presentation.showsResolvedText {
                updated.categoryIdentifier = MomoPushCategoryDemotion.categoryIdentifier(
                    current: updated.categoryIdentifier, resolved: false)
            }
            guard let communication = result.presentation.communication else {
                self.finish(with: updated)
                return
            }
            self.presenter.present(
                ordinaryContent: updated,
                descriptor: communication,
                // 기부는 이 스위치가 켜져 있는 동안만: 읽기 전과 기부 뒤에 다시 읽는다.
                isStillAllowed: { MomoPushPresentationSettings.load(from: container).showSender },
                completion: { [weak self] final in self?.finish(with: final) }
            )
        }
        lock.lock()
        resolutionTask = task
        lock.unlock()
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let task = resolutionTask
        let content = bestAttemptContent
        lock.unlock()
        task?.cancel()
        if let content {
            finish(with: content)
        }
    }

    private func currentContent() -> UNMutableNotificationContent? {
        lock.lock()
        defer { lock.unlock() }
        return bestAttemptContent
    }

    private func finish(with content: UNNotificationContent) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        bestAttemptContent = nil
        resolutionTask = nil
        lock.unlock()
        handler?(content)
    }
}
