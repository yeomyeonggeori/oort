import Foundation
import Security

// =============================================================================
// The keychain half of a lock-screen decision (#3931, ADR-0204 D6).
//
// Two items in TWO services, ONE access group — the app-only group
// (`…app.momo.ios.devicekey`), never the shared one the notification extension
// reads. A credential that can approve things must not be somewhere a second
// binary can reach, which is why the group is read from the plist key the
// extension's Info.plist does not carry, and why an unresolved group is "no
// credential" and never "the default group" (an item written or read without a
// group goes to the FIRST entitlement group, and that is the shared one).
//
//   app.momo.ios.pushaction          written by JS (src/push/pushActionSession.ts):
//     push-action-session            base URL, workspace, the token, when it lapses.
//   app.momo.ios.pushaction.secret   written HERE, once, 32 random bytes. It is what
//     device-secret-v1               makes the decision's idempotency key unguessable
//                                    (MomoPushActionDecisionKey.swift) and it must
//                                    outlive every token re-mint.
//
// ## Why two SERVICES, not two accounts
//
// react-native-keychain's `setGenericPassword` first deletes EVERY generic-password
// item of the service in that group — its query names the service and the group,
// never the account (RNKeychainManager.m `deletePasswordsForOptions`) — and its
// `getGenericPassword` has no account filter either. Two accounts under one service
// would have JS wipe the secret on every publish, and a read that can return the
// wrong one of the two. One service per item is also how every other item JS writes
// in this app already lives. The independent security review of #3931 found this
// (finding 1); the Jest keychain mock is keyed by service and so cannot.
//
// Both are `AfterFirstUnlockThisDeviceOnly` and not synchronizable: a lock-screen
// button is pressed on a phone that has been unlocked since boot, and neither
// item may ride an iCloud backup to another device.
//
// The SecItem calls sit behind a three-method client so the logic above them —
// create once, race, corrupt value, locked keychain — runs in `sim-check/`,
// where a spawned CLI has no entitlement for an access group.
// =============================================================================

protocol MomoPushActionKeychainClient: Sendable {
  func copyData(_ query: [String: Any]) -> (status: OSStatus, data: Data?)
  func add(_ attributes: [String: Any]) -> OSStatus
  func delete(_ query: [String: Any]) -> OSStatus
}

struct MomoPushActionSecItemClient: MomoPushActionKeychainClient {
  func copyData(_ query: [String: Any]) -> (status: OSStatus, data: Data?) {
    var query = query
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    return (status, status == errSecSuccess ? result as? Data : nil)
  }

  func add(_ attributes: [String: Any]) -> OSStatus {
    SecItemAdd(attributes as CFDictionary, nil)
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    SecItemDelete(query as CFDictionary)
  }
}

struct MomoPushActionKeychain: MomoPushActionCredentials {
  static let secretLength = 32

  /// One read-or-create at a time, process-wide: two taps in quick succession
  /// must not each decide the secret is missing and each invent one.
  private static let secretLock = NSLock()

  let accessGroup: String
  let client: MomoPushActionKeychainClient
  let randomSecret: @Sendable () -> Data?

  init(
    accessGroup: String,
    client: MomoPushActionKeychainClient = MomoPushActionSecItemClient(),
    randomSecret: @escaping @Sendable () -> Data? = { MomoPushActionKeychain.systemRandomSecret() }
  ) {
    self.accessGroup = accessGroup
    self.client = client
    self.randomSecret = randomSecret
  }

  /// The app-only group from this build's Info.plist, or nil when this build
  /// cannot name one: an unexpanded `$(…)`, a missing key, or a group that is
  /// not the app-only one. Nil is "no credential" — see the header.
  static func accessGroup(from raw: Any?) -> String? {
    guard let value = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !value.isEmpty, !value.hasPrefix("$("),
      value.hasSuffix(".\(MomoPushActionContract.accessGroupSuffix)")
    else { return nil }
    return value
  }

  static func live() -> MomoPushActionKeychain? {
    guard
      let group = accessGroup(
        from: Bundle.main.object(forInfoDictionaryKey: MomoPushActionContract.accessGroupInfoKey))
    else { return nil }
    return MomoPushActionKeychain(accessGroup: group)
  }

  static func systemRandomSecret() -> Data? {
    var bytes = [UInt8](repeating: 0, count: secretLength)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      return nil
    }
    return Data(bytes)
  }

  /// The full address of an item. Exactly what react-native-keychain writes for
  /// JS's item (`kSecClassGenericPassword`, the service as given, the username as
  /// the account, the access group, not synchronizable) — pushFetchSession.ts
  /// documents the correspondence line by line, and the extension has read an
  /// item of the same shape since #3121.
  func query(service: String, account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
      kSecAttrSynchronizable as String: false,
    ]
  }

  func readSession() -> MomoPushActionSession? {
    let answer = client.copyData(
      query(
        service: MomoPushActionContract.keychainService,
        account: MomoPushActionContract.sessionAccount))
    guard answer.status == errSecSuccess, let data = answer.data else { return nil }
    return MomoPushActionSession.decode(data)
  }

  /// The phone's secret, created on first use. Nil when the keychain will not
  /// say — a locked store is NOT "missing", and inventing a second secret over a
  /// first one that merely could not be read would change the key of every
  /// notification already on the screen.
  func readDeviceSecret() -> Data? {
    Self.secretLock.lock()
    defer { Self.secretLock.unlock() }

    let address = query(
      service: MomoPushActionContract.deviceSecretService,
      account: MomoPushActionContract.deviceSecretAccount)
    let existing = client.copyData(address)
    switch existing.status {
    case errSecSuccess:
      if let data = existing.data, data.count == Self.secretLength { return data }
      // Present but not what this module wrote: it signs nothing it should, so
      // it is replaced rather than hashed.
      _ = client.delete(address)
    case errSecItemNotFound:
      break
    default:
      return nil
    }

    guard let fresh = randomSecret(), fresh.count == Self.secretLength else { return nil }
    var attributes = address
    attributes[kSecValueData as String] = fresh
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    switch client.add(attributes) {
    case errSecSuccess:
      return fresh
    case errSecDuplicateItem:
      // Another writer got there between the read and the add; theirs stands.
      let winner = client.copyData(address)
      if winner.status == errSecSuccess, let data = winner.data, data.count == Self.secretLength {
        return data
      }
      return nil
    default:
      return nil
    }
  }
}

/// A build that cannot name the app-only group has no credential to read: every
/// lock-screen decision then ends as 「…하지 못했어요」 (finish it in the app) instead of reaching
/// into whatever group the keychain would default to.
struct MomoPushActionNoCredentials: MomoPushActionCredentials {
  func readSession() -> MomoPushActionSession? { nil }
  func readDeviceSecret() -> Data? { nil }
}
