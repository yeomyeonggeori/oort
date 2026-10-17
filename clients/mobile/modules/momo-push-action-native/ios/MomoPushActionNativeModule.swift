import ExpoModulesCore

// =============================================================================
// MomoPushAction — the smallest JS surface that can be honest (#3931).
//
// The handler (MomoPushActionHandler.swift) does its work with no JS runtime, so
// there is nothing for JS to call. What JS needs is one fact: whether a native
// handler has really taken over the lock screen's 승인/거절. `handlePushResponse`
// steps aside on that and only on that (src/push/native.ts
// `nativeApprovalHandlerAttached`), because stepping aside for a handler that is
// not there — a build without this module, a launch path that never called
// `install()` — would leave the buttons doing nothing at all, quietly.
//
// The constant is read when the module is created, which is after
// `application(_:didFinishLaunchingWithOptions:)` has run `install()`.
// =============================================================================

public class MomoPushActionNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MomoPushAction")

    Constant("handlesApprovalActions") { MomoPushActionInstaller.isInstalled }
  }
}
