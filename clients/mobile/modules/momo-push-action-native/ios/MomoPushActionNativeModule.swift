import ExpoModulesCore

// =============================================================================
// MomoPushAction — the smallest JS surface that can be honest (#3931).
//
// The handler (MomoPushActionHandler.swift) does its work with no JS runtime, so
// for 승인/거절 there is nothing for JS to call. (The one exception, #6036: the lock
// screen's 답장 is KEPT here, not sent — the push_action token may not send a message —
// and JS reads, removes and clears that list through the three functions below. They
// touch only the reply list, never the session item or a token.) What JS needs is one fact: whether a native
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

    // 답장 (#6036). True only when the handler is attached AND this build names the
    // app-only keychain group the list lives in: JS stops sending a reply itself on this
    // and only this, so an older binary under newer JS keeps the old path.
    Constant("handlesReplyActions") {
      MomoPushActionInstaller.isInstalled && MomoPushActionKeychain.live() != nil
    }

    // Asked per response, not read once: whether a reply arriving now is kept (handler,
    // app-only group AND a session item that says whose it is). See `keepsNow`.
    Function("keepsRepliesNow") { () -> Bool in
      MomoPushReplyCapture.keepsNow()
    }

    // The kept replies, each the JSON `MomoPushQueuedReply`. Nil when the keychain will
    // not answer (locked before the first unlock): "unknown", not "empty".
    Function("queuedReplies") { () -> [String]? in
      guard let store = MomoPushActionKeychain.live()?.replyStore, let all = store.all() else {
        return nil
      }
      return all.compactMap { String(data: $0, encoding: .utf8) }
    }

    Function("removeQueuedReply") { (clientMsgId: String) in
      MomoPushActionKeychain.live()?.replyStore.remove(account: clientMsgId)
    }

    Function("clearQueuedReplies") {
      MomoPushActionKeychain.live()?.replyStore.removeAll()
    }
  }
}
