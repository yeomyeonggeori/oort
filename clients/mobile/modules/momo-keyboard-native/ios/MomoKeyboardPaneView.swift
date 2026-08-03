import ExpoModulesCore
import UIKit

// =============================================================================
// The conversation pane, lifted by the keyboard, with no JavaScript in the loop.
//
// ## What was still wrong after goal RN-P2
//
// RN-P2 moved the TRAVEL to the native driver and measured the win (arrival
// 353ms → 228/245ms, holding up under a 75%-busy JS thread). It said plainly
// what it had not fixed, in `src/lib/useKeyboard.ts`:
//
//     "the event that arms the animation is still a JS callback. A JS thread
//      that is busy when `keyboardWillShow` arrives delays `start()` itself.
//      […] So: the travel is free of the JS thread, the starting gun is not."
//
// and gave the reason it stopped there — binding the keyboard frame natively
// "needs a native module […] and adding a pod rewrites the Xcode project this
// batch is forbidden to touch."
//
// **That last clause turns out to be false for a LOCAL Expo module**, and that
// is why this file can exist. `use_expo_modules!` + `expo.autolinking
// .nativeModulesDir` (package.json) picks up any directory under `modules/`, and
// its Swift is compiled into a pod. `ios/MomoMobile.xcodeproj/project.pbxproj`
// is not touched at all — which matters more than usual right now, because the
// NSE target that goal RN-N1 just attached lives in that file and two gates
// (`scripts/verify_ios_signing.sh`, `scripts/verify_push_kit_inheritance.sh`)
// exist to notice if it moves.
//
// ## The sequence, and where the frames went
//
//   before   UIKit posts the notification
//            → RN's RCTKeyboardObserver formats it and sends it to JS
//            → the JS thread gets around to running the listener
//            → `Animated.timing(...).start()`
//            → the native driver begins
//
//   now      UIKit posts the notification
//            → this observer runs, on the main thread, in that same runloop turn
//            → `UIView.animate` commits, and Core Animation draws the next vsync
//
// Every arrow that was removed is a queue the JS thread could be at the front
// of. The keyboard comes up at precisely the moment this client is busiest —
// the composer re-filtering mentions while a `FlatList` re-renders — which is
// why the removed arrows are the whole complaint ("키보드보다 늦게 올라와").
//
// ## Why the transform goes on `self` and that is safe
//
// Read out of React Native 0.86.2 rather than hoped for:
//
//   `UIView+ComponentViewProtocol.mm:84-109` sets layout with `self.center` and
//   `self.bounds` and NEVER `self.frame`, with its own comment saying why:
//   "Changing `frame` when `layer.transform` is not the identity transform is
//   undefined behavior. Therefore, we must use `center` and `bounds`." So a
//   transform here survives every layout pass by construction. (`bounds.origin`
//   would NOT — the same line resets it to zero — which is why this is a
//   transform and not a bounds offset.)
//
//   `RCTViewComponentView.mm:350-360` writes `self.layer.transform` only when
//   the `transform` PROP changed. `ConversationLayout` sets no transform style
//   on this view, so `transform.operations` stays empty and React Native never
//   writes the property at all.
//
//   `ExpoFabricView.swift:166-171` — `shouldBeRecycled()` is `false` for Expo
//   views, so `prepareForRecycle`'s transform reset cannot reach this either.
//
// And `ExpoView` IS the Fabric component view (`ExpoView = ExpoFabricView`,
// `ExpoFabricViewObjC : RCTViewComponentView`), so React children are mounted
// as this view's own subviews and move with it. No container, no override.
//
// ## What is deliberately NOT here
//
// The pane's `paddingBottom` stays a constant on the JS side. It is a layout
// property; animating it was the original defect, and paying it as a constant is
// what keeps the send button out of the home-indicator gesture area while the
// keyboard is down. This view only ever translates.
// =============================================================================

public final class MomoKeyboardPaneView: ExpoView {
  /**
   How much bottom safe-area inset the pane already pays as padding, in points.

   The lift is `keyboardHeight - bottomInset`, clamped at zero: a raised keyboard
   already covers the home indicator, so travelling the full height would leave a
   dead band between the input and the keys. JS owns this number (it comes from
   `react-native-safe-area-context`) and hands it down, rather than this view
   reading `safeAreaInsets` itself, so that the two cannot disagree about the
   value in the same frame.
   */
  var bottomInset: CGFloat = 0 {
    didSet {
      guard bottomInset != oldValue else { return }
      // No animation: nothing about the keyboard changed, only the arithmetic.
      applyLift(targetLift(forKeyboardHeight: keyboardHeight), animated: false)
    }
  }

  /// The last keyboard overlap this view was told about, in points.
  private var keyboardHeight: CGFloat = 0
  /// Where the pane is going (or has arrived), in points. Negative is up.
  private var lift: CGFloat = 0

  private var displayLink: CADisplayLink?
  private var record: MomoKeyboardTravelRecord?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    // `willChangeFrame` alone, deliberately. It is posted for a show, a hide and
    // a height change alike, so one handler covers all three and there is no
    // second handler to race with the first. `willShow`/`willHide` are left to
    // React Native's own observer, which is what keeps `useKeyboard()` — still
    // used by `MessageEditorSheet` — in step with this view for free.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(keyboardWillChangeFrame(_:)),
      name: UIResponder.keyboardWillChangeFrameNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    displayLink?.invalidate()
  }

  // MARK: - The lift

  private func targetLift(forKeyboardHeight height: CGFloat) -> CGFloat {
    return -max(height - bottomInset, 0)
  }

  @objc
  private func keyboardWillChangeFrame(_ notification: Notification) {
    // First line of the handler, before any work: this is the instant the rest
    // of the batch is measured against, and charging our own arithmetic to the
    // keyboard would flatter the number.
    let startedAt = CACurrentMediaTime()

    guard let window = window,
          let info = notification.userInfo,
          let endValue = info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue
    else { return }

    // Screen coordinates → window coordinates, the same conversion
    // `RCTKeyboardObserver.mm:124-125` does. It matters on an iPad in split view
    // or Stage Manager, where the window is not the screen; without it this
    // view and React Native's own keyboard height would disagree.
    let endFrame = window.convert(endValue.cgRectValue, from: window.screen.coordinateSpace)
    let overlap = max(0, window.bounds.maxY - endFrame.minY)
    let target = targetLift(forKeyboardHeight: overlap)

    keyboardHeight = overlap

    // Idempotent, and that is what lets the handler be attached to more than one
    // notification safely: a second event carrying the same destination is not
    // a second animation, it is the same one described twice. (iOS does send
    // duplicates — a `didShow` whose height equals the `willShow` before it.)
    guard abs(target - lift) > 0.5 else { return }

    let durationRaw = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0
    // Mirrors `src/lib/useKeyboard.ts`: iOS occasionally reports 0, and a
    // keyboard that took no time still needs a tick to be seen moving.
    let duration = durationRaw > 0.01 ? durationRaw : 0.25
    let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int) ?? 7
    let simulated = (info[MomoKeyboardSimulatedKey] as? Bool) ?? false

    beginRecording(
      startedAt: startedAt,
      from: Double(presentedLift()),
      to: Double(target),
      duration: duration,
      curve: curve,
      simulated: simulated
    )
    applyLift(target, animated: true, duration: duration, curve: curve)
    // The line after the animation is committed, still inside the notification
    // handler. See `commitMs` — this is the only reading here that a display
    // refresh interval cannot inflate.
    if record != nil {
      record?.commitMs = (CACurrentMediaTime() - startedAt) * 1000
    }
  }

  private func applyLift(
    _ target: CGFloat,
    animated: Bool,
    duration: Double = 0,
    curve: Int = 7
  ) {
    lift = target
    MomoKeyboardTravelStore.shared.setLift(Double(target))
    let destination = CGAffineTransform(translationX: 0, y: target)

    guard animated else {
      transform = destination
      return
    }

    // The system's own curve, exactly — not an approximation of it. iOS animates
    // the keyboard on `UIViewAnimationCurve` 7, which has no public name, and
    // the documented way to ride it is to shift the raw value into the options
    // field. `src/lib/useKeyboard.ts` had to approximate it with a bezier
    // because the curve never survives the trip to JS: RN's
    // `RCTAnimationNameForCurve` maps everything it does not recognise to the
    // string "keyboard" (`RCTKeyboardObserver.mm:98-112`).
    //
    // `.allowUserInteraction` because a pane that swallows touches for the
    // length of the keyboard animation is a new defect, and `.beginFromCurrentState`
    // so a reversal mid-flight starts from where the pane actually is rather
    // than snapping to where the last animation was headed.
    let options: UIView.AnimationOptions = [
      UIView.AnimationOptions(rawValue: UInt(curve) << 16),
      .beginFromCurrentState,
      .allowUserInteraction,
    ]
    UIView.animate(withDuration: duration, delay: 0, options: options) {
      self.transform = destination
    }
  }

  /// What the screen is showing right now, which during an animation is not what
  /// the model layer says.
  private func presentedLift() -> CGFloat {
    if let presentation = layer.presentation() {
      return presentation.transform.m42
    }
    return layer.transform.m42
  }

  // MARK: - The instrument (see MomoKeyboardTravel.swift)

  private func beginRecording(
    startedAt: CFTimeInterval,
    from: Double,
    to: Double,
    duration: Double,
    curve: Int,
    simulated: Bool
  ) {
    displayLink?.invalidate()
    record = MomoKeyboardTravelRecord(
      startedAt: startedAt,
      fromPx: from,
      toPx: to,
      durationSec: duration,
      curve: curve,
      simulated: simulated
    )
    let link = CADisplayLink(target: self, selector: #selector(sampleFrame(_:)))
    // `.common` so the sampling survives a scroll: the one moment this most
    // needs to be honest is while the list is moving under the reader's thumb.
    link.add(to: .main, forMode: .common)
    displayLink = link
  }

  @objc
  private func sampleFrame(_ link: CADisplayLink) {
    guard var current = record else {
      link.invalidate()
      displayLink = nil
      return
    }

    // `targetTimestamp`, not "now": the honest question is when the moved pixel
    // is ON SCREEN, and that is the frame this callback is preparing. See the
    // note in MomoKeyboardTravel.swift for why one vsync is the right resolution
    // for a claim phrased as "within one frame".
    let atMs = (link.targetTimestamp - current.startedAt) * 1000
    let presented = Double(presentedLift())
    current.frames += 1

    if current.igniteMs < 0 && abs(presented - current.fromPx) > 0.5 {
      current.igniteMs = atMs
    }
    // Is Core Animation actually running it yet? Asked of the layer rather than
    // inferred from how far it has moved — see `armedMs`.
    if current.armedMs < 0, let keys = layer.animationKeys(), !keys.isEmpty {
      current.armedMs = atMs
    }
    if current.arriveMs < 0 && abs(presented - current.toPx) <= 0.5 {
      current.arriveMs = atMs
    }
    let low = min(current.fromPx, current.toPx)
    let high = max(current.fromPx, current.toPx)
    if presented > low + 0.5 && presented < high - 0.5 {
      current.midFlight += 1
    }
    record = current

    // Stop on arrival, or half a second past the time iOS said it would take —
    // a run that never got there has to be able to say so rather than sample
    // forever.
    let elapsed = link.targetTimestamp - current.startedAt
    if current.arriveMs >= 0 || elapsed > current.durationSec + 0.5 {
      link.invalidate()
      displayLink = nil
      record = nil
      MomoKeyboardTravelStore.shared.store(current)
    }
  }
}

/// Marks a frame this app posted itself (`simulateKeyboard`) so a measurement can
/// never quietly claim iOS produced it. The harness prints which one it got, for
/// the same reason `keyboardSource` already exists on the JS side.
let MomoKeyboardSimulatedKey = "MomoKeyboardSimulated"
