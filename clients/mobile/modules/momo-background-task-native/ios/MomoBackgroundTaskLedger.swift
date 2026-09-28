import Foundation

// =============================================================================
// The bookkeeping behind MomoBackgroundTaskNativeModule (#3098), kept free of
// UIKit so `sim-check/` can run it as a plain simulator binary — a spawned CLI
// has no UIApplication, so the real begin/end cannot be called there.
//
// Why a ledger at all, rather than handing UIBackgroundTaskIdentifier to JS:
//
//   - iOS calls the expiration handler when the extra time runs out, and the
//     task MUST be ended right there or the process is killed for overrunning.
//     The handler therefore ends the task itself. JS does not know that
//     happened; its own `end` arrives later and must not end the same
//     identifier a second time (ending an already-ended identifier is an
//     error Apple logs, and a reused raw value could end someone else's task).
//   - The handler does nothing else. It does not touch the keychain and it
//     does not abandon the rotation: a request already sent cannot be unsent,
//     so if the process is merely suspended the rotation finishes on resume,
//     and if it is killed the keychain still holds the previous token WHOLE
//     (a keychain item update is atomic — there is no half-written token).
//     `end` reports `expired` so the JS side can say so instead of pretending
//     the protection held.
// =============================================================================

/// The two platform calls, so the ledger can be run without UIKit.
public protocol MomoBackgroundTaskPlatform: AnyObject {
  /// Starts a task. Returns the platform's raw identifier, or nil when the
  /// platform refused (`UIBackgroundTaskIdentifier.invalid`).
  func begin(name: String, expiration: @escaping () -> Void) -> Int?
  /// Ends a task the platform started. Called at most once per identifier.
  func end(_ token: Int)
}

/// How a JS `end(handle)` found its task.
public enum MomoBackgroundTaskEnd: String {
  /// This call ended it: the work finished inside the extra time.
  case ended
  /// iOS's expiration handler had already ended it: the work outlived the
  /// extra time and the process may have been suspended meanwhile.
  case expired
  /// Never started, or already ended by an earlier `end`.
  case unknown
}

public final class MomoBackgroundTaskLedger {
  private let platform: MomoBackgroundTaskPlatform
  private let lock = NSLock()
  private var open: [Int: Int] = [:]  // handle -> platform token
  private var expired: Set<Int> = []
  private var nextHandle = 1

  public init(platform: MomoBackgroundTaskPlatform) {
    self.platform = platform
  }

  /// Starts a task and returns the handle JS holds, or nil when the platform
  /// refused. A handle is never a raw platform identifier, so a stale handle
  /// can never end a task somebody else started.
  public func begin(name: String) -> Int? {
    let handle: Int = lock.withLock {
      defer { nextHandle += 1 }
      return nextHandle
    }
    guard
      let token = platform.begin(name: name, expiration: { [weak self] in self?.expire(handle) })
    else { return nil }
    let expiredAlready: Bool = lock.withLock {
      if expired.contains(handle) { return true }
      open[handle] = token
      return false
    }
    // The handler ran before the token was recorded (it cannot on iOS, where
    // both run on the main queue — this is for a platform that does not).
    if expiredAlready {
      platform.end(token)
      return nil
    }
    return handle
  }

  /// Ends the task behind `handle`, unless iOS already did.
  public func end(_ handle: Int) -> MomoBackgroundTaskEnd {
    let outcome: (MomoBackgroundTaskEnd, Int?) = lock.withLock {
      if let token = open.removeValue(forKey: handle) { return (.ended, token) }
      if expired.remove(handle) != nil { return (.expired, nil) }
      return (.unknown, nil)
    }
    if let token = outcome.1 { platform.end(token) }
    return outcome.0
  }

  /// The expiration handler: end now, remember why, touch nothing else.
  func expire(_ handle: Int) {
    let token: Int? = lock.withLock {
      expired.insert(handle)
      return open.removeValue(forKey: handle)
    }
    if let token { platform.end(token) }
  }

  /// Tasks begun and not yet ended by anyone. For the sim-check.
  public var openCount: Int { lock.withLock { open.count } }
}
