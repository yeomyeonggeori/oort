import Foundation
import os

// =============================================================================
// One lock-screen 승인/거절, from the `didReceive` that carried it to the line
// that answers it (#3931, ADR-0204 D6) — and the clock it races.
//
// This is the part of the module that decides whether the process LIVES long
// enough, so it is the part that must not depend on UIKit: the independent
// security review of #3931 broke it five ways (the task taken from inside a
// `Task`, taken off the main queue, not ended on expiry, not ended on the happy
// path, the result never claimed) and every one of them passed the regex tests
// that stood in for it. It now lives behind two small protocols, and
// `sim-check/` runs it with fakes.
//
//   begin    synchronously, inside `didReceive`, BEFORE anything is awaited — asking
//            for background time later is asking after the completion handler has
//            already told iOS this response is finished.
//   result   exactly one of "the request answered" and "iOS ran out of time" writes
//            the line; the other becomes a no-op.
//   end      exactly once, whichever comes first, and always from the expiration
//            handler (the process is killed for overrunning otherwise). iOS may run
//            that handler before `begin` has even returned, so "end" is a request
//            that is honoured as soon as there is a task to end.
// =============================================================================

enum MomoPushActionLog {
  static let logger = Logger(subsystem: "app.momo.ios", category: "push-action")
}

/// The two platform calls behind a background task. The real one is UIApplication
/// (MomoPushActionHandler.swift); the simulator check uses a recorder.
protocol MomoPushActionBackgroundTasks: Sendable {
  /// Starts a task. Returns its raw identifier, or nil when iOS refused (no time to
  /// give). `expiration` runs when the extra time is gone.
  func begin(name: String, expiration: @escaping @Sendable () -> Void) -> Int?
  /// Ends a task this object started. Called at most once per identifier.
  func end(_ token: Int)
}

/// What the job puts on the notification centre.
protocol MomoPushActionNotifying: Sendable {
  /// The line, then the clean-up (the approval's other notifications).
  func apply(_ line: MomoPushActionLine, intent: MomoPushActionIntent) async
  /// For the expiration handler, which may not wait for anything.
  func postWithoutWaiting(_ line: MomoPushActionLine, intent: MomoPushActionIntent)
}

final class MomoPushActionJob: @unchecked Sendable {
  private let intent: MomoPushActionIntent
  private let decider: MomoPushActionDecider
  private let notifier: MomoPushActionNotifying
  private let tasks: MomoPushActionBackgroundTasks

  private let lock = NSLock()
  /// Who writes the result line: the first of "the request answered" and "time ran out".
  private var resultClaimed = false
  /// iOS's expiration handler has run.
  private var expired = false
  /// The background task once iOS has handed one over, whether it has been given back,
  /// and whether anybody has asked for it to be (which can come before there is one).
  private var backgroundTask: Int?
  private var backgroundTaskEnded = false
  private var endRequested = false
  private var work: Task<Void, Never>?

  init(
    intent: MomoPushActionIntent,
    decider: MomoPushActionDecider,
    notifier: MomoPushActionNotifying,
    tasks: MomoPushActionBackgroundTasks
  ) {
    self.intent = intent
    self.decider = decider
    self.notifier = notifier
    self.tasks = tasks
  }

  /// MUST run synchronously inside `didReceive`: the background task is taken
  /// here, before the work is even created.
  func start() {
    // `nil` is iOS refusing: the request still goes, it just has no more time than
    // the process happens to have.
    let token = tasks.begin(name: "oort.push-action.decision") { [weak self] in
      self?.timeRanOut()
    }
    if token == nil {
      MomoPushActionLog.logger.notice("[push] action no background time granted")
    }
    let handBack: Int? = lock.withLock {
      backgroundTask = token
      guard endRequested, let token, !backgroundTaskEnded else { return nil }
      backgroundTaskEnded = true
      return token
    }
    if let handBack { tasks.end(handBack) }

    // The handler can have run inside `begin` already (no time left to give). Its line is
    // out and its end has just been honoured above; starting the request now would be
    // sending one after the clock.
    if lock.withLock({ expired }) { return }

    let task = Task { await self.run() }
    let overtaken: Bool = lock.withLock {
      work = task
      return expired
    }
    if overtaken { task.cancel() }
  }

  /// For the simulator check: returns when the request, the line and the end of the
  /// task have all been done (or skipped because the clock won).
  func waitForCompletion() async {
    let task = lock.withLock { work }
    await task?.value
  }

  private func run() async {
    let outcome = await decider.decide(intent)
    // Time ran out first: its handler wrote the line and has already ended the task.
    guard claimResult() else { return }
    MomoPushActionLog.logger.notice(
      "[push] action \(self.intent.direction.approved ? "approve" : "reject", privacy: .public) -> \(outcome.logName, privacy: .public)"
    )
    await notifier.apply(
      MomoPushActionPlanner.line(for: outcome, intent: intent), intent: intent)
    endBackgroundTask()
  }

  /// iOS calls this when the extra time is gone. The task MUST be ended before this
  /// returns or the process is killed for overrunning, so it is ended here whatever
  /// else happens. The request is cancelled; the server may still have received it,
  /// which is what the idempotency key is for — and why the line it posts says the
  /// result is unknown rather than that nothing happened.
  private func timeRanOut() {
    // Claim BEFORE cancelling: cancelling resumes the request with an error, and the
    // job's own tail would otherwise race this method for the right to write the line.
    let mine = claimResult()
    let running: Task<Void, Never>? = lock.withLock {
      expired = true
      return work
    }
    running?.cancel()
    if mine {
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
      if resultClaimed { return false }
      resultClaimed = true
      return true
    }
  }

  /// Gives the task back — once. Asking before there is a task to give back is
  /// remembered, and `start()` honours it the moment `begin` returns one.
  private func endBackgroundTask() {
    let token: Int? = lock.withLock {
      endRequested = true
      guard let backgroundTask, !backgroundTaskEnded else { return nil }
      backgroundTaskEnded = true
      return backgroundTask
    }
    if let token { tasks.end(token) }
  }
}
