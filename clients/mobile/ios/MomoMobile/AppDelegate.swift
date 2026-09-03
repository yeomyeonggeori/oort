// `internal import`, not a bare `import`: expo-modules-autolinking generates
// Pods/Target Support Files/Pods-MomoMobile/ExpoModulesProvider.swift into THIS
// target with `internal import Expo` (line 10). Two files in one module may not
// import the same module at different access levels, and a bare `import` is
// "ambiguous implicit" rather than internal — it fails the build outright.
internal import Expo
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import UIKit

// =============================================================================
// Why this subclasses ExpoAppDelegate (goal RN-N1, ADR-0137 이행 순서 5)
//
// expo-notifications does not swizzle UIApplicationDelegate. It receives the
// APNs device token through Expo's app-delegate subscriber mechanism:
// `NotificationsAppDelegateSubscriber` / `PushTokenAppDelegateSubscriber`
// implement `ExpoAppDelegateSubscriber`, and only `ExpoAppDelegate` forwards
// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)` on to them
// (node_modules/expo/ios/AppDelegates/ExpoAppDelegate.swift:136).
//
// A plain `UIResponder, UIApplicationDelegate` — what the bare RN template
// generates, and what this file used to be — never forwards that callback, so
// `getDevicePushTokenAsync()` would hang forever without an error. Silent, which
// is exactly the failure class this batch exists to avoid.
//
// The UNUserNotificationCenter delegate is deliberately NOT set here.
// expo-notifications' `NotificationCenterManager` claims it, and it refuses to
// claim it if something else got there first, logging and giving up
// (NotificationCenterManager.swift:51-60) — after which expo's JS listeners are
// dead. Our notification handling attaches through its public multi-delegate
// seam from JS instead; see src/push/notifications.ts.
// =============================================================================

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: ExpoReactNativeFactory?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    // ExpoReactNativeFactory, not RCTReactNativeFactory: it routes root-view
    // creation through ExpoReactDelegate, which is how Expo modules take part in
    // startup. It hard-requires an ExpoReactNativeFactoryDelegate —
    // ExpoReactNativeFactory.swift:33 fatalErrors on anything else.
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "MomoMobile",
      in: window,
      launchOptions: launchOptions
    )

    // Load-bearing: this is what hands the launch event to every registered Expo
    // subscriber. Returning `true` instead would leave expo-notifications
    // uninitialised and the token callback unhooked.
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Warm `oort://` / `momo://` (OS camera, Safari, another app) must reach JS
  // `Linking` 'url'. ExpoAppDelegate only forwards this to Expo subscribers;
  // RCTLinkingManager is not one. Cold launch still uses launchOptions via
  // getInitialURL and is unchanged.
  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if RCTLinkingManager.application(app, open: url, options: options) {
      return true
    }
    return super.application(app, open: url, options: options)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
