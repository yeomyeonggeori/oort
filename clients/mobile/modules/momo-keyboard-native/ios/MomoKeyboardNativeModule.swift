import ExpoModulesCore
import UIKit

// =============================================================================
// MomoKeyboardNative — one view and two measurement functions (goal RN-P3).
//
// The view is the product change; the two functions exist so the claim about it
// can be checked. Both are read-only or test-only and neither is called by the
// app: `src/lib/keyboardPane.tsx` exposes them, `measure/harness.tsx` is the
// only caller.
// =============================================================================

public class MomoKeyboardNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MomoKeyboardNative")

    View(MomoKeyboardPaneView.self) {
      Prop("bottomInset") { (view: MomoKeyboardPaneView, inset: Double) in
        view.bottomInset = CGFloat(inset)
      }
    }

    /**
     The last keyboard travel, as the display saw it.

     Read AFTER the fact on purpose. The previous instrument sampled from JS
     while the animation ran, so a busy JS thread — the exact condition under
     test — degraded the measurement and every number came out an upper bound
     (goal RN-P2 said so itself). Here the timestamps are taken natively off a
     `CADisplayLink`; JS can be as late as it likes collecting them.
     */
    Function("lastTravel") { () -> [String: Double] in
      return MomoKeyboardTravelStore.shared.snapshot()
    }

    /**
     Post a keyboard frame through the notification centre iOS itself uses.

     Needed because the simulator will not raise a software keyboard for a
     focused input under automation — spike #837 found React Native's elements
     absent from the accessibility tree, so nothing can tap, and
     `measure/harness.tsx` has been injecting frames on RN's JS-side emitter
     ever since. That injection could never exercise THIS view, which listens to
     UIKit rather than to JavaScript.

     So the injection moves down a layer: a real `NSNotification`, with a real
     keyboard geometry, on `NotificationCenter.default`. Every observer that
     matters receives it — this view AND `RCTKeyboardObserver`, which is what
     keeps `useKeyboard()` in step — and the only thing still not proved is that
     iOS posts the notification, which is UIKit's contract and was never in
     doubt. The userInfo carries `MomoKeyboardSimulated` so a run can never
     report a simulated frame as an OS one by accident.

     Dispatched to the main queue, which is also what makes it the right
     instrument for the case that matters: JS calls this and then wedges itself,
     and the question is whether the pane still moves. On the main thread, it
     does; that is the whole point of the change.
     */
    Function("simulateKeyboard") { (height: Double, durationMs: Double) in
      DispatchQueue.main.async {
        guard let window = MomoKeyWindow() else { return }
        let screen = window.screen.bounds
        let begin = CGRect(x: 0, y: screen.maxY, width: screen.width, height: CGFloat(height))
        let end = CGRect(
          x: 0,
          y: screen.maxY - CGFloat(height),
          width: screen.width,
          height: max(CGFloat(height), 1)
        )
        let info: [AnyHashable: Any] = [
          UIResponder.keyboardFrameBeginUserInfoKey: NSValue(cgRect: begin),
          UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: end),
          UIResponder.keyboardAnimationDurationUserInfoKey: durationMs / 1000.0,
          // 7 — the private curve iOS actually uses for the keyboard. Using the
          // real value rather than a public one keeps the simulated run on the
          // same timing path as a device run.
          UIResponder.keyboardAnimationCurveUserInfoKey: 7,
          UIResponder.keyboardIsLocalUserInfoKey: true,
          MomoKeyboardSimulatedKey: true,
        ]
        let center = NotificationCenter.default
        center.post(
          name: UIResponder.keyboardWillChangeFrameNotification,
          object: nil,
          userInfo: info
        )
        // The show/hide pair as well, for React Native's observer only — this
        // view ignores them (see the note on its single subscription). Without
        // them `useKeyboard()` never learns the height and the harness's older
        // instruments go quiet.
        center.post(
          name: height > 0
            ? UIResponder.keyboardWillShowNotification
            : UIResponder.keyboardWillHideNotification,
          object: nil,
          userInfo: info
        )
      }
    }
  }
}

/// The key window, without `UIApplication.keyWindow` (deprecated, and wrong in a
/// multi-scene app). Mirrors what `RCTKeyWindow()` does.
private func MomoKeyWindow() -> UIWindow? {
  for scene in UIApplication.shared.connectedScenes {
    guard let windowScene = scene as? UIWindowScene,
          windowScene.activationState == .foregroundActive
    else { continue }
    if let key = windowScene.windows.first(where: { $0.isKeyWindow }) {
      return key
    }
  }
  // A harness run can start before any scene reports `foregroundActive`.
  return UIApplication.shared.connectedScenes
    .compactMap { $0 as? UIWindowScene }
    .flatMap { $0.windows }
    .first { $0.isKeyWindow }
}
