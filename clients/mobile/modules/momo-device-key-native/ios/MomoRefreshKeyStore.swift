import CryptoKit
import Foundation
import Security

// =============================================================================
// MomoRefreshKeyStore — the phone's REFRESH key (#3106; ADR-0146 D-7 증보 #3079).
//
// A second Secure Enclave P-256 key beside the instruction key
// (MomoDeviceKeyStore), for one statement only: `momo.human.refresh_proof.v1`,
// which every `POST /v1/auth/refresh` carries so the server can tell this
// device's retry (a lost answer, the app killed mid-rotation) from a copied
// token. Owner decision 2026-09-28: a separate key, PrivateKeyUsage only,
// ThisDeviceOnly, no biometry.
//
//   1. No biometry, no passcode: `[.privateKeyUsage]` only. Refreshes happen in
//      the background (#3101's background task, a push wake) where Face ID
//      cannot be shown; the instruction key's `biometryCurrentSet` would make
//      every refresh fail there.
//   2. `AfterFirstUnlockThisDeviceOnly` for the key and its keychain item: a
//      locked phone still refreshes; never synchronised, never in a backup.
//   3. The app-only access group (`…app.momo.ios.devicekey`, the same group as
//      the instruction key, NOT the extension's shared group), under its own
//      service/account — a different item. The notification extension cannot
//      read it.
//   4. It signs nothing but a proof it builds itself from typed fields
//      (`proofBytes`), and `checkProofPayload` refuses anything else — a control
//      instruction, a rebind letter, a proof naming another key. The
//      instruction key refuses a refresh proof in turn (it is not in
//      `MomoDeviceKeyStore.signingSchemas`). sim-check proves both directions.
//   5. No trust role: the server keeps it in `session_refresh_key`, never in
//      `member_device_key`; it only narrows what the refresh token allows.
//
// No software fallback: a device without an enclave (every simulator) gets
// `.unsupported` and the refresh goes without a proof.
// =============================================================================

public struct MomoRefreshProof: Equatable {
  /// Compressed SEC1 (33 bytes), base64.
  public let publicKey: String
  /// Lowercase hyphenated UUID, 128 random bits.
  public let nonce: String
  public let signedAtMs: Int64
  /// Raw r‖s (64 bytes), base64.
  public let signature: String
}

public struct MomoRefreshKeyStore {
  /// momo-wire `REFRESH_PROOF_SCHEMA_V1`.
  public static let schema = "momo.human.refresh_proof.v1"
  public static let lineCount = 7

  /// A different item from the instruction key (`app.momo.ios.devicekey` /
  /// `p256-signing-v1`) in the same app-only group.
  static let service = "app.momo.ios.refreshkey"
  static let keyAccount = "p256-refresh-v1"

  /// The access control the enclave blob carries. `SecAccessControlCreateFlags`
  /// raw value, so sim-check can pin it without an enclave.
  public static let accessFlags: SecAccessControlCreateFlags = [.privateKeyUsage]

  /// `create` runs one at a time, process-wide.
  private static let mutations = DispatchQueue(label: "app.momo.ios.refreshkey.mutations")

  let accessGroup: String

  /// The same rule as the instruction key: the app-only group or nothing.
  public init(accessGroup: String) throws {
    let trimmed = accessGroup.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !trimmed.hasPrefix("$(") else {
      throw MomoDeviceKeyFailure.misconfigured("\(MomoDeviceKeyStore.accessGroupInfoKey) is unresolved")
    }
    guard trimmed.hasSuffix(".\(MomoDeviceKeyStore.accessGroupSuffix)") else {
      throw MomoDeviceKeyFailure.misconfigured("'\(trimmed)' is not the app-only group")
    }
    self.accessGroup = trimmed
  }

  public static var secureEnclaveAvailable: Bool { MomoDeviceKeyStore.secureEnclaveAvailable }

  // MARK: - the bytes (pure, so sim-check runs them)

  /// Lowercase hex SHA-256 of the raw refresh token (momo-wire
  /// `refresh_token_sha256_hex`).
  public static func tokenSha256Hex(_ refreshToken: String) -> String {
    SHA256.hash(data: Data(refreshToken.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// A canonical lowercase hyphenated UUID, as the server prints it.
  static func isCanonicalUUID(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    return uuid.uuidString.lowercased() == value
  }

  /// The exact bytes momo-wire `RefreshProof::signed_bytes` verifies:
  /// schema, workspace, member, key, token hash, nonce, time — `\n`-joined, no
  /// trailing newline.
  public static func proofBytes(
    workspaceId: String, memberId: String, publicKey: Data, refreshToken: String,
    nonce: String, signedAtMs: Int64
  ) throws -> Data {
    guard isCanonicalUUID(workspaceId), isCanonicalUUID(memberId), isCanonicalUUID(nonce) else {
      throw MomoDeviceKeyFailure.payloadRejected("ids must be lowercase UUIDs")
    }
    guard publicKey.count == 33, publicKey.first == 0x02 || publicKey.first == 0x03 else {
      throw MomoDeviceKeyFailure.payloadRejected("public key must be 33-byte compressed SEC1")
    }
    guard !refreshToken.isEmpty else {
      throw MomoDeviceKeyFailure.payloadRejected("empty refresh token")
    }
    guard signedAtMs > 0, signedAtMs <= (1 << 53) - 1 else {
      throw MomoDeviceKeyFailure.payloadRejected("signedAtMs out of range")
    }
    let lines = [
      schema, workspaceId, memberId, publicKey.base64EncodedString(),
      tokenSha256Hex(refreshToken), nonce, String(signedAtMs),
    ]
    return Data(lines.joined(separator: "\n").utf8)
  }

  /// The last gate before the enclave: exactly a 7-line refresh proof whose
  /// key line is THIS key. A control instruction, a rebind letter, or a proof
  /// naming another key is refused.
  public static func checkProofPayload(_ message: Data, publicKeyBase64: String) throws {
    guard let text = String(data: message, encoding: .utf8), message.count <= 1024 else {
      throw MomoDeviceKeyFailure.payloadRejected("not a refresh proof")
    }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.count == lineCount, String(lines[0]) == schema else {
      throw MomoDeviceKeyFailure.payloadRejected("not a \(schema) payload")
    }
    guard String(lines[3]) == publicKeyBase64 else {
      throw MomoDeviceKeyFailure.payloadRejected("a refresh proof names another key")
    }
    guard
      !text.unicodeScalars.contains(where: { $0 != "\n" && $0.properties.generalCategory == .control })
    else {
      throw MomoDeviceKeyFailure.payloadRejected("control character other than a line break")
    }
  }

  // MARK: - prove

  /// Sign `momo.human.refresh_proof.v1` for this refresh token, creating the
  /// key on first use. No prompt: the key has no user-presence requirement.
  public func prove(
    workspaceId: String, memberId: String, refreshToken: String, signedAtMs: Int64
  ) throws -> MomoRefreshProof {
    guard Self.secureEnclaveAvailable else { throw MomoDeviceKeyFailure.unsupported }
    let key = try Self.mutations.sync { try loadOrCreateLocked() }
    let publicKey = key.publicKey.compressedRepresentation
    let nonce = UUID().uuidString.lowercased()
    let bytes = try Self.proofBytes(
      workspaceId: workspaceId, memberId: memberId, publicKey: publicKey,
      refreshToken: refreshToken, nonce: nonce, signedAtMs: signedAtMs)
    try Self.checkProofPayload(bytes, publicKeyBase64: publicKey.base64EncodedString())
    let signature: Data
    do {
      signature = try key.signature(for: bytes).rawRepresentation
    } catch {
      throw MomoDeviceKeyFailure.failed("refresh key signing: \(error.localizedDescription)")
    }
    return MomoRefreshProof(
      publicKey: publicKey.base64EncodedString(), nonce: nonce, signedAtMs: signedAtMs,
      signature: signature.base64EncodedString())
  }

  private func loadOrCreateLocked() throws -> SecureEnclave.P256.Signing.PrivateKey {
    if let blob = try readItemOrNil() {
      do {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
      } catch {
        // A blob this enclave cannot open signs nothing; replace it. The
        // server binds a new sign-in's key afresh, and this key has no other
        // role to lose.
        deleteItem()
      }
    }
    var acError: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, Self.accessFlags, &acError)
    else {
      throw MomoDeviceKeyFailure.failed(
        "access control: \(acError?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    let key: SecureEnclave.P256.Signing.PrivateKey
    do {
      key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    } catch {
      throw MomoDeviceKeyFailure.failed("enclave key generation: \(error.localizedDescription)")
    }
    try addItem(key.dataRepresentation)
    return key
  }

  // MARK: - keychain (always the app-only group, its own service)

  private func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: Self.keyAccount,
      kSecAttrAccessGroup as String: accessGroup,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  private func readItemOrNil() throws -> Data? {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    switch status {
    case errSecSuccess: return out as? Data
    case errSecItemNotFound: return nil
    case errSecMissingEntitlement:
      throw MomoDeviceKeyFailure.misconfigured("the app is not entitled to \(accessGroup) (-34018)")
    default: throw MomoDeviceKeyFailure.failed("keychain read \(status)")
    }
  }

  private func addItem(_ data: Data) throws {
    var query = baseQuery()
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    query[kSecAttrSynchronizable as String] = false
    let status = SecItemAdd(query as CFDictionary, nil)
    switch status {
    case errSecSuccess: return
    case errSecDuplicateItem: throw MomoDeviceKeyFailure.alreadyExists
    case errSecMissingEntitlement:
      throw MomoDeviceKeyFailure.misconfigured("the app is not entitled to \(accessGroup) (-34018)")
    default: throw MomoDeviceKeyFailure.failed("keychain write \(status)")
    }
  }

  private func deleteItem() {
    SecItemDelete(baseQuery() as CFDictionary)
  }
}
