import ExpoNotifications
import Foundation
import UIKit
import UserNotifications
import os

// =============================================================================
// The lock screen's 승인/거절, answered natively (#3931, ADR-0204 D6).
//
// ## What was broken
//
// expo-notifications answers iOS the moment a response reaches its delegates:
// `NotificationCenterManager.userNotificationCenter(_:didReceive:…)` polls them
// and then calls the system's completion handler UNCONDITIONALLY
// (NotificationCenterManager.swift:111-124). A process that was not running —
// the usual state of a phone that is locked and has been for hours — is woken
// for that response, JS has not even booted, and the completion is already
// done: iOS suspends the process again before a request could leave. A process
// that was merely suspended had a stale access token and five seconds.
//
// ## What this does instead
//
// It is one more delegate on that same multi-delegate seam, attached at launch
// (`MomoPushActionInstaller.install()` from AppDelegate, BEFORE React Native
// starts — a module's OnCreate runs after the bridge, by which time the first
// response has been parked and answered). On 승인/거절 it takes a background
// task synchronously inside `didReceive` — the only moment it is certain to be
// allowed — so the process lives until ONE request has answered, then it
// replaces the notification with a one-line result.
//
// ## What it returns
//
// `true` for 승인/거절 on an approval notification, `false` for everything else.
// NotificationCenterManager keeps a response in `pendingResponses` only while no
// delegate has handled it, and replays that list to the EmitterModule when JS
// comes up: it is how a cold-launch BODY tap reaches `getLastNotificationResponse`
// (#2569). A `true` for a body tap would eat that landing. The EmitterModule also
// returns `true` for every response, so while JS is alive it sees 승인/거절 too
// — which is why `handlePushResponse` steps aside on iOS when this module is
// linked, and why returning `true` here is not what prevents a second decision.
// It does keep a 승인/거절 out of `pendingResponses`, so a cold launch cannot
// hand the same button to JS later.
//
// This class never calls the `completionHandler` it is given: the manager does,
// right after the loop, and a second call is exactly the double-completion the
// header of src/push/notifications.ts warned about.
// =============================================================================

private enum MomoPushActionLog {
  static let logger = Logger(subsystem: "app.momo.ios", category: "push-action")
}

// MARK: - the network

/// One ephemeral session, no cookies and no cache, that does not follow a
/// redirect: a bearer token stays on the request it was put on.
final class MomoPushActionURLSessionTransport: NSObject, MomoPushActionTransport,
  URLSessionTaskDelegate, @unchecked Sendable
{
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = MomoPushActionRequestBuilder.timeoutSeconds
    configuration.timeoutIntervalForResource = MomoPushActionRequestBuilder.timeoutSeconds + 5
    configuration.waitsForConnectivity = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (http.statusCode, data)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

// MARK: - the notification centre

extension MomoPushActionIntent {
  /// Nil unless this is 승인/거절 on an approval notification. Everything else —
  /// a body tap, a reply, another category — is not this module's.
  init?(response: UNNotificationResponse) {
    guard let direction = MomoPushActionDirection(actionIdentifier: response.actionIdentifier)
    else { return nil }
    let request = response.notification.request
    let content = request.content
    guard content.categoryIdentifier == MomoPushActionContract.approvalCategory else { return nil }
    let userInfo = content.userInfo
    self.init(
      direction: direction,
      requestIdentifier: request.identifier,
      title: content.title,
      body: content.body,
      threadIdentifier: content.threadIdentifier,
      envelope: MomoPushActionEnvelope.parse(userInfo: userInfo),
      // `data(withJSONObject:)` raises an Objective-C exception on anything that
      // is not JSON, which `try?` does not catch.
      origin: JSONSerialization.isValidJSONObject(userInfo)
        ? try? JSONSerialization.data(withJSONObject: userInfo) : nil
    )
  }
}

struct MomoPushActionNotifier: Sendable {
  private func request(for line: MomoPushActionLine, intent: MomoPushActionIntent)
    -> UNNotificationRequest
  {
    let notice = MomoPushActionPlanner.notice(for: line, intent: intent)
    let content = UNMutableNotificationContent()
    content.title = notice.title
    content.body = notice.body
    content.threadIdentifier = notice.threadIdentifier
    content.categoryIdentifier = notice.categoryIdentifier
    content.userInfo = notice.userInfo
    if notice.alerts {
      content.sound = .default
      content.interruptionLevel = .active
    } else {
      // A confirmation of what the person just did: it goes to the list and does
      // not light the screen.
      content.interruptionLevel = .passive
    }
    // No trigger: deliver now.
    return UNNotificationRequest(identifier: notice.identifier, content: content, trigger: nil)
  }

  /// The line first, then the clean-up: if the line cannot be posted (the person
  /// turned notifications off since) the original is still there to tap.
  func apply(_ line: MomoPushActionLine, intent: MomoPushActionIntent) async {
    let center = UNUserNotificationCenter.current()
    do {
      try await center.add(request(for: line, intent: intent))
    } catch {
      MomoPushActionLog.logger.error("[push] action result line not posted")
    }
    guard line.removesSiblings, let envelope = intent.envelope else { return }
    let delivered = await center.deliveredNotifications().map {
      (identifier: $0.request.identifier, userInfo: $0.request.content.userInfo)
    }
    let stale = MomoPushActionPlanner.siblings(
      delivered: delivered, of: envelope, excluding: intent.requestIdentifier)
    if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
  }

  /// For the expiration handler, which may not wait for anything.
  func postWithoutWaiting(_ line: MomoPushActionLine, intent: MomoPushActionIntent) {
    UNUserNotificationCenter.current().add(request(for: line, intent: intent)) { _ in }
  }
}

// MARK: - one tap

/// One 승인/거절, from the `didReceive` that carried it to the line that answers
/// it. The background task and the request race the clock; exactly one of
/// "the request answered" and "iOS ran out of time" writes the result line, and
/// the task is ended exactly once whichever comes first.
final class MomoPushActionJob: @unchecked Sendable {
  private let intent: MomoPushActionIntent
  private let decider: MomoPushActionDecider
  private let notifier: MomoPushActionNotifier

  private let lock = NSLock()
  private var terminalClaimed = false
  private var backgroundTask = UIBackgroundTaskIdentifier.invalid
  private var backgroundTaskEnded = false
  private var work: Task<Void, Never>?

  init(
    intent: MomoPushActionIntent,
    decider: MomoPushActionDecider,
    notifier: MomoPushActionNotifier
  ) {
    self.intent = intent
    self.decider = decider
    self.notifier = notifier
  }

  /// MUST run synchronously inside `didReceive`, on the main thread: asking for
  /// background time later, from the task, is asking after the completion handler
  /// has already told iOS this response is finished.
  func start() {
    let id = Self.onMain {
      UIApplication.shared.beginBackgroundTask(withName: "oort.push-action.decision") {
        [weak self] in
        self?.timeRanOut()
      }
    }
    // `.invalid` is iOS refusing (no time to give): the request still goes, it
    // just has no more time than the process happens to have.
    lock.withLock { backgroundTask = id }
    let task = Task { await self.run() }
    lock.withLock { work = task }
  }

  private func run() async {
    let outcome = await decider.decide(intent)
    guard claimResult() else { return }
    MomoPushActionLog.logger.notice(
      "[push] action \(self.intent.direction.approved ? "approve" : "reject", privacy: .public) -> \(outcome.logName, privacy: .public)"
    )
    await notifier.apply(
      MomoPushActionPlanner.line(for: outcome, intent: intent), intent: intent)
    endBackgroundTask()
  }

  /// iOS calls this on the main queue when the extra time is gone. The task MUST
  /// be ended before this returns or the process is killed for overrunning, so it
  /// is ended here whatever else happens. The request is cancelled; the
  /// server may still have received it, which is what the idempotency key is for —
  /// the card in the app will say the truth.
  private func timeRanOut() {
    let task = lock.withLock { work }
    task?.cancel()
    if claimResult() {
      MomoPushActionLog.logger.notice(
        "[push] action \(self.intent.direction.approved ? "approve" : "reject", privacy: .public) -> failed(timeLimit)"
      )
      notifier.postWithoutWaiting(
        MomoPushActionPlanner.line(for: .failed(.timeLimit), intent: intent), intent: intent)
    }
    endBackgroundTask()
  }

  private func claimResult() -> Bool {
    lock.withLock {
      if terminalClaimed { return false }
      terminalClaimed = true
      return true
    }
  }

  private func endBackgroundTask() {
    let id: UIBackgroundTaskIdentifier? = lock.withLock {
      if backgroundTaskEnded { return nil }
      backgroundTaskEnded = true
      return backgroundTask
    }
    guard let id, id != .invalid else { return }
    Self.onMain { UIApplication.shared.endBackgroundTask(id) }
  }

  /// UIApplication belongs to the main actor. Both callers are on the main queue
  /// in practice (`didReceive`, iOS's expiration handler); the hop covers the
  /// end of a task that finished on a background thread.
  private static func onMain<T>(_ body: @MainActor () -> T) -> T {
    if Thread.isMainThread { return MainActor.assumeIsolated(body) }
    return DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
  }
}

// MARK: - the delegate

public final class MomoPushActionHandler: NSObject, NotificationDelegate {
  private let transport = MomoPushActionURLSessionTransport()

  public func didReceive(
    _ response: UNNotificationResponse,
    completionHandler: @escaping () -> Void
  ) -> Bool {
    guard let intent = MomoPushActionIntent(response: response) else { return false }
    let credentials: MomoPushActionCredentials =
      MomoPushActionKeychain.live() ?? MomoPushActionNoCredentials()
    let decider = MomoPushActionDecider(
      credentials: credentials,
      transport: transport,
      nowMs: { Int64(Date().timeIntervalSince1970 * 1000) }
    )
    MomoPushActionJob(intent: intent, decider: decider, notifier: MomoPushActionNotifier()).start()
    return true
  }
}

/// What AppDelegate calls. Idempotent, and thread-safe because nothing promises
/// which thread `didFinishLaunching` is first reached on in a test host.
public enum MomoPushActionInstaller {
  private final class State: @unchecked Sendable {
    let lock = NSLock()
    var handler: MomoPushActionHandler?
  }

  private static let state = State()

  /// Whether the delegate is attached. The module's JS constant reads this, so
  /// JS steps aside for 승인/거절 only when something native has really taken
  /// them over.
  public static var isInstalled: Bool {
    state.lock.withLock { state.handler != nil }
  }

  /// Attach to expo-notifications' delegate list. Reaching
  /// `NotificationCenterManager.shared` is also what makes it claim
  /// `UNUserNotificationCenter.delegate`, which iOS requires to be set before
  /// `application(_:didFinishLaunchingWithOptions:)` returns.
  public static func install() {
    let attached: Bool = state.lock.withLock {
      guard state.handler == nil else { return false }
      let handler = MomoPushActionHandler()
      NotificationCenterManager.shared.addDelegate(handler)
      state.handler = handler
      return true
    }
    if attached { MomoPushActionLog.logger.notice("[push] action handler attached") }
  }
}
