import Foundation

// Runtime check of MomoBackgroundTaskLedger on the iOS SIMULATOR (#3098).
//
// A spawned CLI has no UIApplication, so the platform is a fake that records
// every begin/end. What is checked is the part that decides whether a task is
// ended exactly once: the normal path, iOS expiring the task before JS ends
// it, a refused begin, and stale or repeated handles.
// Run by ./run.sh.

var failures = 0
func check(_ ok: Bool, _ what: String) {
  print("\(ok ? "ok" : "FAIL"): \(what)")
  if !ok { failures += 1 }
}

final class FakePlatform: MomoBackgroundTaskPlatform {
  var refuse = false
  var nextToken = 100
  var begun: [Int] = []
  var ended: [Int] = []
  var expirations: [Int: () -> Void] = [:]

  func begin(name: String, expiration: @escaping () -> Void) -> Int? {
    if refuse { return nil }
    nextToken += 1
    begun.append(nextToken)
    expirations[nextToken] = expiration
    return nextToken
  }

  func end(_ token: Int) { ended.append(token) }

  /// What iOS does when the extra time runs out.
  func expire(_ token: Int) { expirations[token]?() }
}

// ---- normal path: begin, work, end --------------------------------------------
do {
  let platform = FakePlatform()
  let ledger = MomoBackgroundTaskLedger(platform: platform)
  let handle = ledger.begin(name: "oort.refresh-rotation")
  check(handle != nil, "begin returns a handle")
  check(platform.begun.count == 1 && platform.ended.isEmpty, "the task is open while the work runs")
  check(handle != platform.begun.first, "the handle is not the raw platform identifier")
  check(ledger.end(handle!) == .ended, "end after the work reports ended")
  check(platform.ended == platform.begun, "the platform task is ended exactly once")
  check(ledger.end(handle!) == .unknown, "a second end is a no-op")
  check(platform.ended.count == 1, "a second end does not reach the platform")
  check(ledger.openCount == 0, "nothing left open")
}

// ---- expiration: iOS ends it first, JS ends it later --------------------------
do {
  let platform = FakePlatform()
  let ledger = MomoBackgroundTaskLedger(platform: platform)
  let handle = ledger.begin(name: "oort.refresh-rotation")!
  let token = platform.begun[0]
  platform.expire(token)
  check(platform.ended == [token], "the expiration handler ends the task itself, at once")
  check(ledger.openCount == 0, "an expired task is not left open")
  check(ledger.end(handle) == .expired, "the late JS end is told the time ran out")
  check(platform.ended == [token], "the late JS end does not end the identifier twice")
  check(ledger.end(handle) == .unknown, "and only the first late end hears expired")
  platform.expire(token)
  check(platform.ended == [token], "a repeated expiration does not end it twice")
}

// ---- iOS refuses (UIBackgroundTaskIdentifier.invalid) -------------------------
do {
  let platform = FakePlatform()
  platform.refuse = true
  let ledger = MomoBackgroundTaskLedger(platform: platform)
  check(ledger.begin(name: "oort.refresh-rotation") == nil, "a refused begin answers nil")
  check(platform.ended.isEmpty, "nothing to end after a refusal")
}

// ---- overlapping tasks stay separate ------------------------------------------
do {
  let platform = FakePlatform()
  let ledger = MomoBackgroundTaskLedger(platform: platform)
  let first = ledger.begin(name: "a")!
  let second = ledger.begin(name: "b")!
  check(first != second, "two tasks get two handles")
  platform.expire(platform.begun[0])
  check(ledger.end(second) == .ended, "expiring one does not touch the other")
  check(ledger.end(first) == .expired, "the expired one still reports expired")
  check(platform.ended.sorted() == platform.begun.sorted(), "each identifier ended exactly once")
  check(ledger.end(9999) == .unknown, "an unknown handle is a no-op")
}

print(failures == 0 ? "PASS" : "FAILED (\(failures))")
exit(failures == 0 ? 0 : 1)
