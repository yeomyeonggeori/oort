import Foundation
import Security

// =============================================================================
// The lock screen's 답장, kept until the app can send it (#6036).
//
// ## Why it is kept, not sent
//
// A reply goes out with the person's own session, and only JS holds that. The
// handler's push_action token may call ONE route, the approval decision
// (server-rust/crates/momo-auth/src/push_action_token.rs `push_action_route_allowed`,
// ADR-0204 D6), so this module cannot send a message itself. What it can do is
// stop the reply from vanishing: since the scene life cycle (#6015), a process woken
// in the background for a reply may have no JS to hand it to until the app is
// opened, and expo keeps such a response only in memory.
//
// So `didReceive` writes the reply here, synchronously, before it returns. JS
// drains the list once a person is signed in (`src/push/queuedReplies.ts`): it sends
// each one with the person's session under the id written here, so a retry, or the
// same reply seen twice, is one message on the server.
//
// ## Where it is kept
//
// The text is a message the person wrote, so it is kept like the credentials next
// to it: a keychain item in the APP-ONLY group (never the notification extension's
// shared group), readable after the first unlock, on this device only, not
// synchronizable. One item per reply, in a service of its own that only Swift
// writes: JS's `setGenericPassword` / `resetGenericPassword` wipe a whole service, so
// the push_action session's service would lose every queued reply on a token
// publish.
//
// ## Whose it is
//
// Each reply carries the workspace and the member of the push_action session that
// was on the phone when it was written — the same person JS will send it as.
// Without that session, or for a notification from another workspace, nothing is
// kept: the line says the reply was not sent, so the person knows to send it from
// the app. Keeping it and deleting it at the drain would be the silent loss this file
// exists to remove.
//
// Nothing here logs the text, a token or an identifier.
// =============================================================================

enum MomoPushReplyContract {
  static let replyAction = "momo.action.quick-reply"
  /// The categories that carry the 답장 button (`src/push/categories.ts`).
  static let replyCategories: Set<String> = ["momo.message", "momo.mention"]
  /// Written and read ONLY by this module. See the header for why not
  /// `MomoPushActionContract.keychainService`.
  static let keychainService = "app.momo.ios.pushaction.replies"
  /// The record's shape. A reader that meets another version leaves it alone.
  static let version = 1
}

/// One kept reply, as JS reads it (`src/push/queuedReplies.ts` `QueuedReply`). The key
/// names are the contract; `__tests__/pushActionContract.test.ts` holds them equal.
struct MomoPushQueuedReply: Codable, Equatable, Sendable {
  let v: Int
  /// The message's idempotency key on the server (`clientMsgId`), chosen here.
  let clientMsgId: String
  let workspaceID: String
  let memberID: String
  /// The text as the person typed it, trimmed.
  let text: String
  /// The notification's request identifier: the line that says 「앱을 열면 보내요」 is
  /// posted under it, so JS can take it down once the reply is sent.
  let requestIdentifier: String
  /// The notification's id-only payload, as JSON text. JS's own envelope reader
  /// (`parsePushEnvelope`) finds the channel and the thread in it; this file reads only
  /// the workspace.
  let origin: String
  let createdAtMs: Int64
}

/// The fields of the push_action session item that say whose it is. The token in the
/// same item is not decoded here.
struct MomoPushReplyOwner: Equatable, Sendable {
  let workspaceID: String
  let memberID: String

  private struct Wire: Decodable {
    let workspaceID: String
    let memberID: String
  }

  static func decode(_ data: Data) -> MomoPushReplyOwner? {
    guard let wire = try? JSONDecoder().decode(Wire.self, from: data),
      UUID(uuidString: wire.workspaceID) != nil, UUID(uuidString: wire.memberID) != nil
    else { return nil }
    return MomoPushReplyOwner(
      workspaceID: wire.workspaceID.lowercased(), memberID: wire.memberID.lowercased())
  }
}

/// What became of one reply. Only the NAME is ever logged.
enum MomoPushReplyOutcome: String, Equatable, Sendable {
  case queued
  /// Already kept: iOS handed the same response over twice.
  case alreadyQueued
  /// Signed out, or no session item this module can read.
  case noOwner
  /// The notification is from a workspace other than the session's.
  case otherWorkspace
  case unreadableNotification
  /// The keychain would not keep it (locked before the first unlock, no app-only group, …).
  case storeFailed

  var kept: Bool { self == .queued || self == .alreadyQueued }
  /// The one thing about a reply that is written to the log: a name.
  var logName: String { "reply(\(rawValue))" }
}

/// The keychain calls the list needs. The real one is `MomoPushReplySecItemStore`; the
/// simulator check uses a dictionary.
protocol MomoPushReplyStore: Sendable {
  /// Every item's data, or nil when the keychain will not answer.
  func all() -> [Data]?
  func add(account: String, data: Data) -> Bool
  func remove(account: String)
  func removeAll()
}

enum MomoPushReplyCapture {
  /// Whether this response is a 답장 this module takes.
  static func isReply(actionIdentifier: String, categoryIdentifier: String) -> Bool {
    actionIdentifier == MomoPushReplyContract.replyAction
      && MomoPushReplyContract.replyCategories.contains(categoryIdentifier)
  }

  /// The workspace a payload names, lower-cased, or nil.
  static func workspaceID(of userInfo: [AnyHashable: Any]) -> String? {
    guard let momo = userInfo["momo"] as? [String: Any],
      let value = momo["workspace_id"] as? String, UUID(uuidString: value) != nil
    else { return nil }
    return value.lowercased()
  }

  /// Keep one reply. `text` is already trimmed and not empty.
  static func keep(
    text: String,
    requestIdentifier: String,
    userInfo: [AnyHashable: Any],
    owner: MomoPushReplyOwner?,
    store: MomoPushReplyStore,
    newID: () -> String = { UUID().uuidString.lowercased() },
    nowMs: Int64
  ) -> MomoPushReplyOutcome {
    guard let workspace = workspaceID(of: userInfo),
      JSONSerialization.isValidJSONObject(userInfo),
      let originData = try? JSONSerialization.data(withJSONObject: userInfo),
      let origin = String(data: originData, encoding: .utf8)
    else { return .unreadableNotification }
    guard let owner else { return .noOwner }
    guard owner.workspaceID == workspace else { return .otherWorkspace }

    // The same response twice (one reply, one notification) is one reply.
    if let existing = store.all() {
      let decoder = JSONDecoder()
      for data in existing {
        if let kept = try? decoder.decode(MomoPushQueuedReply.self, from: data),
          kept.requestIdentifier == requestIdentifier, kept.text == text
        {
          return .alreadyQueued
        }
      }
    }

    let reply = MomoPushQueuedReply(
      v: MomoPushReplyContract.version,
      clientMsgId: newID(),
      workspaceID: workspace,
      memberID: owner.memberID,
      text: text,
      requestIdentifier: requestIdentifier,
      origin: origin,
      createdAtMs: nowMs
    )
    guard let data = try? JSONEncoder().encode(reply),
      store.add(account: reply.clientMsgId, data: data)
    else { return .storeFailed }
    return .queued
  }
}

// MARK: - the keychain

struct MomoPushReplySecItemStore: MomoPushReplyStore {
  let accessGroup: String

  private func base() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: MomoPushReplyContract.keychainService,
      kSecAttrAccessGroup as String: accessGroup,
      kSecAttrSynchronizable as String: false,
    ]
  }

  func all() -> [Data]? {
    var query = base()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess: return (result as? [Data]) ?? []
    case errSecItemNotFound: return []
    default: return nil
    }
  }

  func add(account: String, data: Data) -> Bool {
    var attributes = base()
    attributes[kSecAttrAccount as String] = account
    attributes[kSecValueData as String] = data
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
  }

  func remove(account: String) {
    var query = base()
    query[kSecAttrAccount as String] = account
    _ = SecItemDelete(query as CFDictionary)
  }

  func removeAll() {
    _ = SecItemDelete(base() as CFDictionary)
  }
}

extension MomoPushActionKeychain {
  /// Whose replies this phone would keep now: the workspace and member of the
  /// push_action session item, or nil. Reads the same item `readSession()` reads.
  func readReplyOwner() -> MomoPushReplyOwner? {
    let answer = client.copyData(
      query(
        service: MomoPushActionContract.keychainService,
        account: MomoPushActionContract.sessionAccount))
    guard answer.status == errSecSuccess, let data = answer.data else { return nil }
    return MomoPushReplyOwner.decode(data)
  }

  /// The list, in the same app-only group.
  var replyStore: MomoPushReplyStore { MomoPushReplySecItemStore(accessGroup: accessGroup) }
}

// MARK: - the line

/// The lock screen's answer to a 답장, in the app's language as iOS resolves it (ko or
/// en — the two localizations the app bundle carries). The same sentences are catalog
/// keys `mobile.pushReply.*`; `__tests__/pushActionContract.test.ts` holds them equal.
enum MomoPushReplyCopy {
  static func isKorean(_ preferred: [String]) -> Bool {
    (preferred.first ?? "ko").lowercased().hasPrefix("ko")
  }

  static func queued(korean: Bool) -> String {
    korean ? "답장은 앱을 열면 보내요" : "Your reply will be sent when you open oort"
  }

  static func notKeptTitle(korean: Bool) -> String {
    korean ? "답장을 보내지 못했어요" : "Your reply wasn't sent"
  }

  static func notKeptBody(korean: Bool) -> String {
    korean ? "앱을 열어 다시 보내 주세요" : "Open oort to send it again"
  }
}
