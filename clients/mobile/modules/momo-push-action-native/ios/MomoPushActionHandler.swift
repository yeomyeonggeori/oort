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
// `true` for 승인/거절 on an approval notification and for a 답장 (#6036, kept on the
// list in MomoPushReplyQueue.swift before this returns), `false` for everything else.
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

// MARK: - the network

/// One ephemeral session, no cookies and no cache, that does not follow a
/// redirect: a bearer token stays on the request it was put on.
final class MomoPushActionURLSessionTransport: NSObject, MomoPushActionTransport,
  URLSessionTaskDelegate, @unchecked Sendable
{
  /// Built once, in `init`: a lazily built session could be built twice by two taps
  /// that arrive together.
  private var session: URLSession!

  override init() {
    super.init()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = MomoPushActionRequestBuilder.timeoutSeconds
    configuration.timeoutIntervalForResource = MomoPushActionRequestBuilder.timeoutSeconds + 5
    configuration.waitsForConnectivity = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }

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
        ? try? JSONSerialization.data(withJSONObject: userInfo) : nil,
      relayAlert: MomoPushActionRelayAlert.read(userInfo: userInfo)
    )
  }
}

struct MomoPushActionNotifier: MomoPushActionNotifying {
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

// MARK: - background time

/// UIApplication behind the job's two-method seam. UIApplication belongs to the main
/// actor; both callers are on the main queue in practice (`didReceive`, iOS's
/// expiration handler), and the hop covers the end of a task that finished on a
/// background thread.
struct MomoPushActionUIKitTasks: MomoPushActionBackgroundTasks {
  func begin(name: String, expiration: @escaping @Sendable () -> Void) -> Int? {
    let id = Self.onMain {
      UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expiration)
    }
    return id == .invalid ? nil : id.rawValue
  }

  func end(_ token: Int) {
    Self.onMain { UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: token)) }
  }

  private static func onMain<T: Sendable>(_ body: @MainActor () -> T) -> T {
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
    // 답장 (#6036): kept here, synchronously, before this returns — a live EmitterModule
    // hears the same response right after, and JS then finds it on the list. See
    // MomoPushReplyQueue.swift.
    let content = response.notification.request.content
    if MomoPushReplyCapture.isReply(
      actionIdentifier: response.actionIdentifier, categoryIdentifier: content.categoryIdentifier)
    {
      guard let input = response as? UNTextInputNotificationResponse else { return false }
      let text = input.userText.trimmingCharacters(in: .whitespacesAndNewlines)
      // Nothing typed is nothing to send (JS treated it the same way).
      if text.isEmpty { return true }
      MomoPushReplyKeeper.keep(text: text, request: response.notification.request)
      return true
    }
    guard let intent = MomoPushActionIntent(response: response) else { return false }
    let credentials: MomoPushActionCredentials =
      MomoPushActionKeychain.live() ?? MomoPushActionNoCredentials()
    let decider = MomoPushActionDecider(
      credentials: credentials,
      transport: transport,
      nowMs: { Int64(Date().timeIntervalSince1970 * 1000) }
    )
    MomoPushActionJob(
      intent: intent, decider: decider, notifier: MomoPushActionNotifier(),
      tasks: MomoPushActionUIKitTasks()
    ).start()
    return true
  }
}

/// Keeps one 답장 and answers it on the lock screen with one line.
enum MomoPushReplyKeeper {
  static func keep(text: String, request: UNNotificationRequest) {
    let content = request.content
    let outcome: MomoPushReplyOutcome
    if let keychain = MomoPushActionKeychain.live() {
      outcome = MomoPushReplyCapture.keep(
        text: text,
        requestIdentifier: request.identifier,
        userInfo: content.userInfo,
        owner: keychain.readReplyOwner(),
        store: keychain.replyStore,
        nowMs: Int64(Date().timeIntervalSince1970 * 1000)
      )
    } else {
      outcome = .storeFailed
    }
    MomoPushActionLog.logger.notice("[push] \(outcome.logName, privacy: .public)")

    let korean = MomoPushReplyCopy.isKorean(Bundle.main.preferredLocalizations)
    let line = UNMutableNotificationContent()
    if outcome.kept {
      line.title = MomoPushReplyCopy.queued(korean: korean)
      // What the person just did, confirmed: to the list, without lighting the screen.
      line.interruptionLevel = .passive
    } else {
      line.title = MomoPushReplyCopy.notKeptTitle(korean: korean)
      line.body = MomoPushReplyCopy.notKeptBody(korean: korean)
      line.sound = .default
      line.interruptionLevel = .active
    }
    line.threadIdentifier = content.threadIdentifier
    // The id-only payload under `origin`, as the 승인/거절 line carries it: a tap on the
    // line lands on the conversation (`pushPayloadOfRequest`). No category, no buttons.
    let userInfo = content.userInfo
    if JSONSerialization.isValidJSONObject(userInfo),
      let data = try? JSONSerialization.data(withJSONObject: userInfo)
    {
      line.userInfo = MomoPushActionPlanner.userInfo(origin: data)
    }
    // The same identifier replaces the notification that was answered.
    let replacement = UNNotificationRequest(identifier: request.identifier, content: line, trigger: nil)

    let tasks = MomoPushActionUIKitTasks()
    let finish = MomoPushReplyTaskEnd(tasks: tasks)
    finish.token = tasks.begin(name: "oort.push-action.reply") { finish.end() }
    UNUserNotificationCenter.current().add(replacement) { error in
      if error != nil { MomoPushActionLog.logger.error("[push] reply line not posted") }
      finish.end()
    }
  }
}

/// Ends a background task once, whichever of "posted" and "expired" comes first.
final class MomoPushReplyTaskEnd: @unchecked Sendable {
  private let tasks: MomoPushActionBackgroundTasks
  private let lock = NSLock()
  private var ended = false
  var token: Int? {
    get { lock.withLock { storedToken } }
    set {
      let handBack: Int? = lock.withLock {
        storedToken = newValue
        return ended ? newValue : nil
      }
      if let handBack { tasks.end(handBack) }
    }
  }
  private var storedToken: Int?

  init(tasks: MomoPushActionBackgroundTasks) { self.tasks = tasks }

  func end() {
    let handBack: Int? = lock.withLock {
      guard !ended else { return nil }
      ended = true
      return storedToken
    }
    if let handBack { tasks.end(handBack) }
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
    guard state.lock.withLock({ state.handler != nil }) else { return false }
    // expo gives up claiming UNUserNotificationCenter.delegate when something else got
    // there first (NotificationCenterManager.swift:51-60), and then NOTHING reaches this
    // handler: a handler added to a list nobody calls is not a handler. JS stepping
    // aside for it would leave the buttons dead.
    return (UNUserNotificationCenter.current().delegate as AnyObject?) === NotificationCenterManager.shared
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
