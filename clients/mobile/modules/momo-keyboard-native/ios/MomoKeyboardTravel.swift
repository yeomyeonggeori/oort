import QuartzCore

// =============================================================================
// The instrument, fixed (goal RN-P3).
//
// ## Why the old one could not answer the question it was asked
//
// The requirement is "첫 이동 ≤ 17ms" — one frame. The previous instrument read
// the travel from JS, through `Animated.Value.addListener`, and goal RN-P2 said
// so in its own report: the native driver reports frames back to JS on a
// JS-scheduled callback, so every number it produces is an UPPER BOUND that
// includes however long the JS thread happened to be busy. Under the one
// condition worth testing — a busy JS thread — the instrument is degraded by
// exactly the thing under test. It cannot prove 17ms and it cannot disprove it.
//
// So the measurement moved to where the animation is. This records, on the main
// thread, off a `CADisplayLink`, reading the PRESENTATION layer — the values
// Core Animation is actually putting on screen. JS is not in the loop; it reads
// the record afterwards, whenever it gets around to it, and being late costs
// nothing because the timestamps were taken natively.
//
// ## What `igniteMs` means exactly, and why it is not flattering
//
// It is `CADisplayLink.targetTimestamp - t0`: the moment the first moved frame
// will be ON SCREEN, measured from the instant the keyboard notification handler
// began. Not when we noticed, not when the animation was committed — when the
// pixel changes.
//
// That makes one vsync the resolution, which is the right resolution for this
// claim: "moved within one frame" is true if and only if the movement is on the
// very next vsync, and this number is ≤17 exactly then. An ignition that has to
// wait for a JS round trip misses that vsync and lands on the one after it, and
// the number says 33 rather than 17. The instrument discriminates the two cases
// it exists to tell apart, and it cannot be talked into the answer.
// =============================================================================

/// One keyboard raise or lower, as the display saw it.
struct MomoKeyboardTravelRecord {
  /// `CACurrentMediaTime()` when the notification handler was entered.
  let startedAt: CFTimeInterval
  let fromPx: Double
  let toPx: Double
  /// The duration iOS asked for, in seconds.
  let durationSec: Double
  /// The raw `UIViewAnimationCurve` iOS sent — 7, the private one, in practice.
  let curve: Int
  /// Did the frame come from UIKit (`false`) or from `simulateKeyboard` (`true`)?
  let simulated: Bool

  /// ms from `startedAt` to the first frame DISPLAYED away from `fromPx`.
  ///
  /// **This is displacement, not ignition, and the difference turned out to
  /// matter.** It is the first frame on which the pane has moved more than half
  /// a point, and on a 302pt travel over an eased curve that takes a couple of
  /// frames NO MATTER how promptly the animation started. Read `armedMs` beside
  /// it before concluding anything about lateness.
  var igniteMs: Double = -1

  /// ms from `startedAt` to the first frame on which the animation was RUNNING.
  ///
  /// The question "did the ignition leave the JS thread" is about whether Core
  /// Animation had the animation by the next vsync, not about how far an eased
  /// curve had got by then. This asks the layer directly (`animationKeys()`),
  /// so the easing and the environment's animation time-scale cannot flatter or
  /// damn it. `igniteMs` remains the number the batch was given a bar for; this
  /// is the one that says which half a failure belongs to.
  var armedMs: Double = -1

  /// ms from the notification to `UIView.animate` having COMMITTED the travel.
  ///
  /// The one number here with no vsync in it, and the reason it exists: the two
  /// above are quantised by `CADisplayLink`, whose first callback already
  /// reports a `targetTimestamp` two vsyncs out. That floor (~33ms at 60Hz) sits
  /// above the 17ms bar, so those instruments cannot answer the question no
  /// matter how fast the pane is — measured 28.1 / 32.4 / 31.4ms with `armedMs`
  /// identical to `igniteMs` in every run, which is the signature of a floor
  /// rather than of a slow animation.
  ///
  /// This is taken with `CACurrentMediaTime()` on the line after the animation
  /// is handed to Core Animation, on the main thread, in the same runloop turn
  /// as the notification. It is the ignition latency proper: everything after it
  /// belongs to the display, and the display's own bound is one refresh
  /// interval.
  var commitMs: Double = -1
  /// ms from `startedAt` to the first frame displayed at `toPx`.
  var arriveMs: Double = -1
  /// How many frames were sampled at all.
  var frames: Int = 0
  /// How many of them were strictly between the two ends — i.e. it GLIDED.
  var midFlight: Int = 0
}

/// Where the last record lives until JS asks for it.
///
/// A singleton because the pane is a singleton in practice (one conversation on
/// screen) and because the alternative — reaching a view instance from a module
/// function — would make the harness's read depend on view identity, which is
/// one more thing that can be wrong in a measurement.
final class MomoKeyboardTravelStore {
  static let shared = MomoKeyboardTravelStore()

  private let lock = NSLock()
  private var last: MomoKeyboardTravelRecord?
  /// Where the pane is resting right now, in points (negative is up).
  private var lift: Double = 0

  func store(_ record: MomoKeyboardTravelRecord) {
    lock.lock()
    last = record
    lock.unlock()
  }

  func setLift(_ value: Double) {
    lock.lock()
    lift = value
    lock.unlock()
  }

  /// Flat and numeric on purpose.
  ///
  /// Every value crosses into JS as a `Double`, including the two booleans, so
  /// the bridge conversion cannot be the reason a measurement is missing. `-1`
  /// keeps its meaning from the rest of this codebase: **could not measure**,
  /// which is never the same statement as zero.
  func snapshot() -> [String: Double] {
    lock.lock()
    defer { lock.unlock() }
    guard let record = last else {
      return ["available": 0, "liftPx": lift]
    }
    return [
      "available": 1,
      "igniteMs": record.igniteMs,
      "armedMs": record.armedMs,
      "commitMs": record.commitMs,
      "arriveMs": record.arriveMs,
      "frames": Double(record.frames),
      "midFlight": Double(record.midFlight),
      "fromPx": record.fromPx,
      "toPx": record.toPx,
      "durationMs": record.durationSec * 1000,
      "curve": Double(record.curve),
      "simulated": record.simulated ? 1 : 0,
      "liftPx": lift,
    ]
  }
}
