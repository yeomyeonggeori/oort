import ExpoModulesCore
import UIKit

// =============================================================================
// MomoBackgroundTask (#3098) — extra background time for a refresh rotation.
//
// iOS suspends an app about five seconds after it leaves the foreground. A
// refresh rotation caught in that window is the worst case of the single-use
// token (MOMO-300): the server has already revoked the token it was shown, the
// response carrying the replacement never arrives, and the keychain keeps a
// token that is now dead — the next launch signs the person out, and since
// #3065 the server may read the retry as theft. Apple's answer is to call
// `beginBackgroundTask` BEFORE the work starts and `endBackgroundTask` once it
// is done (developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time,
// claudedocs/refresh-loss/research.md §3). `src/storage/secureSession.ts`
// brackets the rotation with it: begin before the POST leaves, end after the
// new token is in the keychain.
//
// The bookkeeping (and why the expiration handler does what it does) lives in
// MomoBackgroundTaskLedger.swift.
// =============================================================================

/// UIApplication behind the ledger's protocol. Both functions below run on the
/// main queue (`runOnQueue(.main)`), which is where UIApplication belongs; iOS
/// also calls the expiration handler on the main queue.
private final class UIKitBackgroundTaskPlatform: MomoBackgroundTaskPlatform {
  func begin(name: String, expiration: @escaping () -> Void) -> Int? {
    let id = MainActor.assumeIsolated {
      UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expiration)
    }
    return id == .invalid ? nil : id.rawValue
  }

  func end(_ token: Int) {
    MainActor.assumeIsolated {
      UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: token))
    }
  }
}

public class MomoBackgroundTaskNativeModule: Module {
  private let ledger = MomoBackgroundTaskLedger(platform: UIKitBackgroundTaskPlatform())

  public func definition() -> ModuleDefinition {
    Name("MomoBackgroundTask")

    // Returns the handle, or nil when iOS refused (then the work simply runs
    // without extra time, exactly as it did before this module).
    AsyncFunction("begin") { [ledger] (name: String) -> Int? in
      ledger.begin(name: name)
    }.runOnQueue(.main)

    // "ended" | "expired" | "unknown" — see MomoBackgroundTaskEnd.
    AsyncFunction("end") { [ledger] (handle: Int) -> String in
      ledger.end(handle).rawValue
    }.runOnQueue(.main)
  }
}
