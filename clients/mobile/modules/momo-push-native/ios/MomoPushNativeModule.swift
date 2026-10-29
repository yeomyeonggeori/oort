import ExpoModulesCore

// =============================================================================
// MomoPushNative — a small native surface (goal RN-N1; widened once, #4316).
//
// It reads two Info.plist keys. It deliberately does NOT touch the keychain,
// UNUserNotificationCenter, or the APNs registration: all of that lives in JS on top of
// expo-notifications, and every native line added here would be a line the RN migration was supposed to
// delete.
//
// ## The one widening: the App Group presentation state (#4316, ADR-0204 증보 5)
//
// A notification extension cannot run the app's React tree, and its credential may read two server routes
// only, so what it needs to dress a push as a communication notification — the sender's photo, the
// channel's name, the person's two display switches — has to be handed to it through the App Group, by the
// app, in native code (JS has no path into a group container). Four functions and nothing else:
//
//   setPresentationSettings(previewEnabled, showSender)    the two switches of 설정 › 알림
//   exportAvatar(baseUrl, workspaceId, memberId, version, fileUri)   a face the app already downloaded
//   exportChannels(baseUrl, workspaceId, channels)         ids → kind and name
//   clearPresentation()                                    sign-out / switch off: cache gone, donations asked to go
//
// The layout and every limit are in `MomoPushPresentationStore.swift` (compiled by the extension too);
// `MomoPushPresentationBridge.swift` is the app-only half. `src/push/presentation.ts` is the only caller.
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

    // A deletion of the donated interactions that an earlier run began and did not finish (the process
    // was suspended, the system was busy) is finished here, before JS has any say.
    OnCreate {
      MomoPushPresentationBridge.retryPendingCleanup()
    }

    // None of these throws into JS: a write that did not happen answers `false` (see the Bridge).
    AsyncFunction("setPresentationSettings") { (previewEnabled: Bool, showSender: Bool) -> Bool in
      MomoPushPresentationBridge.setSettings(previewEnabled: previewEnabled, showSender: showSender)
    }

    AsyncFunction("exportAvatar") {
      (baseUrl: String, workspaceId: String, memberId: String, version: String, fileUri: String) -> Bool in
      MomoPushPresentationBridge.exportAvatar(
        baseURL: baseUrl, workspaceID: workspaceId, memberID: memberId, version: version, fileURI: fileUri)
    }

    AsyncFunction("exportChannels") { (baseUrl: String, workspaceId: String, channels: [[String: Any]]) -> Bool in
      MomoPushPresentationBridge.exportChannels(baseURL: baseUrl, workspaceID: workspaceId, channels: channels)
    }

    AsyncFunction("clearPresentation") { (promise: Promise) in
      MomoPushPresentationBridge.clear { confirmed in promise.resolve(confirmed) }
    }
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
