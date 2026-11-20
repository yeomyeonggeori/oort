// Same access level as AppDelegate.swift: ExpoModulesProvider.swift, generated into
// this target, imports Expo as `internal`, and two files of one module may not
// import it at different levels.
internal import Expo
import UIKit

// The scene delegate Info.plist's UIApplicationSceneManifest names (#6015). An app
// built with the iOS 27 SDK must adopt the UIScene life cycle or UIKit stops it at
// launch. ExpoAppSceneDelegate (expo, ios/AppDelegates) creates the window from the
// connecting UIWindowScene, starts React Native into it with AppDelegate's factory,
// and re-feeds scene events (URLs, user activities, life cycle) to AppDelegate.
// `@objc(SceneDelegate)` fixes the Objective-C name; Info.plist names the class as
// `$(PRODUCT_MODULE_NAME).SceneDelegate`, the way Expo's own app template does.
@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {}
