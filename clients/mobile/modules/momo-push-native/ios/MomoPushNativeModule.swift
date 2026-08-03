import ExpoModulesCore

// =============================================================================
// MomoPushNative — the smallest possible native surface (goal RN-N1).
//
// It reads two Info.plist keys and stops. It deliberately does NOT touch the
// keychain, UNUserNotificationCenter, or the APNs registration: all of that
// lives in JS on top of expo-notifications, and every native line added here
// would be a line the RN migration was supposed to delete.
//
// Why these two values cannot be JS constants:
//
//   MomoAPNSEnvironment  = $(APS_ENVIRONMENT), which Xcode sets PER BUILD
//     CONFIGURATION (Debug=development, Release=production, project.pbxproj).
//     JS can only see `__DEV__`, and `__DEV__` is not the same question: a
//     Release build signed with a development profile carries
//     aps-environment=development while `__DEV__` is false. Registering that
//     token as `production` sends every push to the wrong APNs host, and
//     nothing reports an error — the notifications simply never arrive.
//     (audit 2026-08-02 §7.2 #9.)
//
//   MomoKeychainAccessGroup = $(AppIdentifierPrefix)app.momo.ios.shared. The
//     prefix is the Apple team id, injected at build time from the signing
//     configuration. Hardcoding "YWQQFQM38J." in JS would work until the day it
//     silently doesn't. Reading the same Info.plist key the extension reads
//     (MomoPushKit/PushNotification.swift:30-32) means the writer and the reader
//     cannot disagree about where the item lives — which is the single failure
//     the 2026-08-02 audit called the hardest to detect (§2.3).
//
// Both are exposed as Constants (synchronous, available before first render) so
// the registration path never has to choose between waiting and guessing.
// =============================================================================

public class MomoPushNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MomoPushNative")

    Constants([
      "apnsEnvironment": momoInfoValue("MomoAPNSEnvironment"),
      "keychainAccessGroup": momoInfoValue("MomoKeychainAccessGroup")
    ])
  }
}

/// A free function rather than a method: `Constants { }` takes a closure, and a
/// method call inside it would capture `self`, holding the module alive from its
/// own definition. Nothing here needs instance state.
///
/// Returns "" rather than nil for a missing or unexpanded key. The JS side reads
/// "" as "this build cannot answer", which is louder than a null that reads as
/// "not applicable".
private func momoInfoValue(_ key: String) -> String {
  guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
    return ""
  }
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  // An unexpanded build setting means the Info.plist shipped the literal "$(...)"
  // text. That is a build misconfiguration, not a value.
  if trimmed.hasPrefix("$(") { return "" }
  return trimmed
}
