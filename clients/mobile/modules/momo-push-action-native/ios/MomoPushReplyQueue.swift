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
// What became of each response is also remembered in memory for the life of the
// process (`MomoPushReplyOutcomes`): the live JS that hears the same response right
// after asks THAT, not "would a reply be kept now" and not "is it still on the list"
// (#6092). A kept reply is sent from the list and nowhere else, even when the drain
// has already sent and removed it by the time JS asks; one that was not kept is sent
// by JS itself, as before this file existed.
//
// ## How long a reply is kept (ADR-0204 증보 7 A7-13)
//
// Age is counted from `createdAtMs`. JS does not send a reply 24 hours old or more
// (it moves it to the conversation's draft instead). At 7 days or more the reply is
// deleted unsent, and so is any item this build cannot read (another shape version,
// bytes that do not decode). That sweep needs no signed-in person: it runs when the
// app starts (`MomoPushActionInstaller.install()`) and each time a new reply is kept,
// so a phone nobody signs in to again, or an app deleted and installed again, does
// not keep a person's words for ever. An unreadable item cannot say which
// conversation it was for, so it goes without a word.
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
  /// The record's shape. An item of another version cannot be read by this build and is
  /// deleted by the sweep (A7-13 지우는 때 6). Adding an OPTIONAL field keeps the version.
  static let version = 1
  /// At this age or more a reply is deleted unsent, signed in or not (A7-13).
  static let maxAgeMs: Int64 = 7 * 24 * 60 * 60 * 1000
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
  /// Set once the server has plainly refused the reply (JS, `markQueuedReplyRefused`):
  /// it is never sent again, only moved to the draft when the slot is free (A7-13).
  /// Optional, so an item written before it existed still reads as version 1.
  let refusedAtMs: Int64?

  func refused(atMs: Int64) -> MomoPushQueuedReply {
    MomoPushQueuedReply(
      v: v, clientMsgId: clientMsgId, workspaceID: workspaceID, memberID: memberID, text: text,
      requestIdentifier: requestIdentifier, origin: origin, createdAtMs: createdAtMs,
      refusedAtMs: refusedAtMs ?? atMs)
  }
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

/// One keychain item of the list: its account (the reply's `clientMsgId` when it was
/// written by this module) and its bytes.
struct MomoPushReplyEntry: Sendable {
  let account: String
  let data: Data
}

/// The keychain calls the list needs. The real one is `MomoPushReplySecItemStore`; the
/// simulator check uses a dictionary.
protocol MomoPushReplyStore: Sendable {
  /// Every item, with its account, or nil when the keychain will not answer. The
  /// account is what lets the sweep delete an item whose bytes it cannot read.
  func entries() -> [MomoPushReplyEntry]?
  func add(account: String, data: Data) -> Bool
  /// Replace the bytes of an existing item. False when there is none or the keychain refused.
  func update(account: String, data: Data) -> Bool
  func remove(account: String)
  func removeAll()
}

extension MomoPushReplyStore {
  /// Every item's bytes (what JS reads), or nil when the keychain will not answer.
  func all() -> [Data]? { entries()?.map(\.data) }
}

/// What the handler did with each 답장 it took, for the life of the process (#6092).
///
/// JS used to ask "would a reply be kept now" (a fresh keychain read) and step aside
/// on yes. That answer could differ from what had just happened: the session item is
/// deleted and written again on every token publish, and a read in that gap said no
/// while the handler had kept the reply (two rows), or yes while it had not (a reply
/// sent by nobody, under a line that says it was not sent). Asking "is it on the list"
/// fails too: the drain removes an item as soon as the server has it. So the handler
/// writes down what it did, here, before `didReceive` returns, and JS asks for that
/// response by its identifier. Nothing in it is a text, a token or a key: an
/// identifier and a boolean.
final class MomoPushReplyOutcomes: @unchecked Sendable {
  static let shared = MomoPushReplyOutcomes()
  /// A person answers a handful of notifications per launch; the oldest go first.
  static let capacity = 64

  private let lock = NSLock()
  private var kept: [String: Bool] = [:]
  private var order: [String] = []

  func record(requestIdentifier: String, kept wasKept: Bool) {
    lock.withLock {
      if kept[requestIdentifier] == nil { order.append(requestIdentifier) }
      kept[requestIdentifier] = wasKept
      while order.count > Self.capacity { kept[order.removeFirst()] = nil }
    }
  }

  /// True: kept (JS must not send it). False: taken and NOT kept (JS sends it). Nil: the
  /// handler never took this response in this process.
  func outcome(requestIdentifier: String) -> Bool? {
    lock.withLock { kept[requestIdentifier] }
  }
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

  /// The `message_id` a payload names, lower-cased, or nil.
  static func messageID(of userInfo: [AnyHashable: Any]) -> String? {
    guard let momo = userInfo["momo"] as? [String: Any],
      let value = momo["message_id"] as? String, UUID(uuidString: value) != nil
    else { return nil }
    return value.lowercased()
  }

  static func messageID(ofOrigin origin: String) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(origin.utf8)) as? [String: Any]
    else { return nil }
    return messageID(of: object)
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

    // Old and unreadable items go first, so the list a new reply joins holds none (A7-13).
    MomoPushReplySweep.sweep(store: store, nowMs: nowMs)

    // The same response twice (one reply, one notification) is one reply. The message the
    // notification was about is part of "the same": notifications of one collapse id share
    // an identifier, so the same words answering two messages are two replies.
    let message = messageID(of: userInfo)
    if let existing = store.all() {
      let decoder = JSONDecoder()
      for data in existing {
        if let kept = try? decoder.decode(MomoPushQueuedReply.self, from: data),
          kept.requestIdentifier == requestIdentifier, kept.text == text,
          messageID(ofOrigin: kept.origin) == message
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
      createdAtMs: nowMs,
      refusedAtMs: nil
    )
    guard let data = try? JSONEncoder().encode(reply),
      store.add(account: reply.clientMsgId, data: data)
    else { return .storeFailed }
    return .queued
  }

  /// Mark one reply as refused by the server, so it is not sent again (A7-13 다시 보내지
  /// 않는 항목). False when there is no such readable item or the keychain refused.
  static func markRefused(clientMsgId: String, store: MomoPushReplyStore, nowMs: Int64) -> Bool {
    guard let entry = store.entries()?.first(where: { $0.account == clientMsgId }),
      let reply = try? JSONDecoder().decode(MomoPushQueuedReply.self, from: entry.data),
      reply.v == MomoPushReplyContract.version,
      let data = try? JSONEncoder().encode(reply.refused(atMs: nowMs))
    else { return false }
    return store.update(account: clientMsgId, data: data)
  }
}

/// Deletes what may not stay on the list whoever is signed in (A7-13 지우는 때 6 · 7).
enum MomoPushReplySweep {
  /// Remove every item this build cannot read (bytes that do not decode, another version)
  /// and every item `maxAgeMs` old or more. Answers the notification identifiers of the
  /// aged ones, so their 「앱을 열면 보내요」 line can be taken down; an unreadable item
  /// names none. A keychain that will not answer is left alone: unknown is not empty.
  @discardableResult
  static func sweep(store: MomoPushReplyStore, nowMs: Int64) -> [String] {
    guard let entries = store.entries() else { return [] }
    let decoder = JSONDecoder()
    var aged: [String] = []
    for entry in entries {
      guard let reply = try? decoder.decode(MomoPushQueuedReply.self, from: entry.data),
        reply.v == MomoPushReplyContract.version
      else {
        store.remove(account: entry.account)
        continue
      }
      if nowMs - reply.createdAtMs >= MomoPushReplyContract.maxAgeMs {
        store.remove(account: entry.account)
        aged.append(reply.requestIdentifier)
      }
    }
    return aged
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

  func entries() -> [MomoPushReplyEntry]? {
    var query = base()
    query[kSecReturnData as String] = true
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      let items = (result as? [[String: Any]]) ?? []
      return items.compactMap { item in
        guard let account = item[kSecAttrAccount as String] as? String,
          let data = item[kSecValueData as String] as? Data
        else { return nil }
        return MomoPushReplyEntry(account: account, data: data)
      }
    case errSecItemNotFound: return []
    default: return nil
    }
  }

  func update(account: String, data: Data) -> Bool {
    var query = base()
    query[kSecAttrAccount as String] = account
    let changes = [kSecValueData as String: data] as CFDictionary
    return SecItemUpdate(query as CFDictionary, changes) == errSecSuccess
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
