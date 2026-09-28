import CryptoKit
import Foundation
import LocalAuthentication
import Security

// =============================================================================
// MomoDeviceKeyStore — the phone's human device key (ADR-0146 개정 2026-09-28,
// D-1·D-2; issue #3026 R2-E6 stage 1).
//
// This file deliberately imports nothing from Expo, so it can be compiled on its
// own for the simulator (`sim-check/run.sh`) and asserted at RUNTIME, not only
// read as text.
//
// The four properties the ADR asks for, and where each one lives:
//
//   1. P-256 in the Secure Enclave, never in software (D-1).
//      Every key is `SecureEnclave.P256.Signing.PrivateKey`. The software type
//      `P256.Signing.PrivateKey` is never constructed anywhere in this module —
//      a device without an enclave (every simulator) gets `.unsupported`, not a
//      quiet software key that would look identical to JS and to the server.
//
//   2. `biometryCurrentSet` (D-2). Each signature needs Face ID; the device
//      passcode cannot stand in, and re-enrolling Face ID makes the key
//      permanently unusable. The access control lives INSIDE the enclave blob,
//      so the enclave enforces it, not this code.
//
//   3. An app-only keychain access group (D-2). The key blob is stored under
//      `$(AppIdentifierPrefix)app.momo.ios.devicekey`, which only the app target
//      declares. The notification extension declares only the shared group
//      (`app.momo.ios.shared`) and therefore cannot even read the blob, let alone
//      raise Face ID. The group is ALWAYS passed explicitly: with no group, an
//      item lands in the FIRST group of the entitlement list, which is the
//      shared one (secureSession.ts, "One consequence worth knowing").
//
//   4. The private key never leaves the enclave. What this file stores is the
//      enclave's opaque `dataRepresentation` — a handle only this device's
//      enclave can use — and what it returns is the compressed SEC1 public key
//      (33 bytes) and raw r‖s signatures (64 bytes).
//
// Out of scope for stage 1: the signed payload bytes (E1 #3021) and the server
// registration (E2 #3022). `sign` takes arbitrary bytes.
// =============================================================================

public enum MomoDeviceKeyStatus: String {
  /// No Secure Enclave on this device (every simulator). Nothing can be created.
  case unsupported
  /// The enclave exists but no biometry is enrolled, so a `biometryCurrentSet`
  /// key cannot be created.
  case biometryUnavailable
  /// No key yet.
  case absent
  /// A key exists and the enrolled biometry has not changed since it was made.
  case ready
  /// A key exists but can never sign again (Face ID re-enrolled or removed).
  /// The caller deletes it and creates a new one, which then needs a fresh
  /// endorsement from the root Mac (ADR-0146 D-6).
  case invalidated
}

public enum MomoDeviceKeyFailure: Error, Equatable {
  case unsupported
  case biometryUnavailable
  case misconfigured(String)
  case alreadyExists
  case absent
  case invalidated
  case cancelled
  case lockedOut
  case failed(String)

  /// The `code` JS sees on the rejected promise. Mirrored by
  /// `src/deviceKey/native.ts` (`DEVICE_KEY_ERROR_CODES`).
  public var code: String {
    switch self {
    case .unsupported: return "DEVICE_KEY_UNSUPPORTED"
    case .biometryUnavailable: return "DEVICE_KEY_BIOMETRY_UNAVAILABLE"
    case .misconfigured: return "DEVICE_KEY_MISCONFIGURED"
    case .alreadyExists: return "DEVICE_KEY_ALREADY_EXISTS"
    case .absent: return "DEVICE_KEY_ABSENT"
    case .invalidated: return "DEVICE_KEY_INVALIDATED"
    case .cancelled: return "DEVICE_KEY_CANCELLED"
    case .lockedOut: return "DEVICE_KEY_LOCKED_OUT"
    case .failed: return "DEVICE_KEY_FAILED"
    }
  }

  public var message: String {
    switch self {
    case .unsupported: return "This device has no Secure Enclave; no device key can exist here."
    case .biometryUnavailable: return "No biometry is enrolled; a biometryCurrentSet key cannot be created."
    case .misconfigured(let why): return "Device key access group is misconfigured: \(why)"
    case .alreadyExists: return "A device key already exists. Delete it first."
    case .absent: return "No device key exists."
    case .invalidated: return "The device key can no longer sign (biometry enrollment changed)."
    case .cancelled: return "The user cancelled Face ID."
    case .lockedOut: return "Biometry is locked out; unlock the phone with its passcode first."
    case .failed(let why): return "Device key operation failed: \(why)"
    }
  }
}

public struct MomoDeviceKeyStore {
  /// The access group WITHOUT the team prefix. Must match
  /// `ios/MomoMobile/MomoMobile.entitlements`, the app `Info.plist`
  /// (`MomoDeviceKeyAccessGroup`) and `DEVICE_KEY_ACCESS_GROUP` in
  /// `src/deviceKey/native.ts`; `__tests__/deviceKeyContract.test.ts` compares.
  public static let accessGroupSuffix = "app.momo.ios.devicekey"
  public static let accessGroupInfoKey = "MomoDeviceKeyAccessGroup"

  static let service = "app.momo.ios.devicekey"
  static let keyAccount = "p256-signing-v1"
  static let domainStateAccount = "biometry-domain-state-v1"

  let accessGroup: String

  /// Refuses any group that is not the app-only one. Falling back to "no group"
  /// here would put the key into the shared group the extension reads.
  public init(accessGroup: String) throws {
    let trimmed = accessGroup.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !trimmed.hasPrefix("$(") else {
      throw MomoDeviceKeyFailure.misconfigured("\(Self.accessGroupInfoKey) is unresolved")
    }
    guard trimmed.hasSuffix(".\(Self.accessGroupSuffix)") else {
      throw MomoDeviceKeyFailure.misconfigured("'\(trimmed)' is not the app-only group")
    }
    self.accessGroup = trimmed
  }

  /// Compile-time AND runtime: the simulator branch is not left to whatever
  /// `SecureEnclave.isAvailable` happens to report there.
  public static var secureEnclaveAvailable: Bool {
    #if targetEnvironment(simulator)
      return false
    #else
      return SecureEnclave.isAvailable
    #endif
  }

  // MARK: - status

  /// Throws only `.misconfigured`/`.failed` (the keychain itself refused): a
  /// missing entitlement must not read as "no key yet".
  public func status() throws -> MomoDeviceKeyStatus {
    guard Self.secureEnclaveAvailable else { return .unsupported }
    guard let blob = try readItemOrNil(Self.keyAccount) else {
      return biometryEnrolled() ? .absent : .biometryUnavailable
    }
    // A blob this enclave cannot open (restored onto other hardware — which
    // ThisDeviceOnly should already prevent) can never sign.
    guard (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)) != nil else {
      return .invalidated
    }
    return biometryChangedSinceCreation() ? .invalidated : .ready
  }

  // MARK: - create

  /// Returns the compressed SEC1 public key (33 bytes).
  public func create() throws -> Data {
    guard Self.secureEnclaveAvailable else { throw MomoDeviceKeyFailure.unsupported }
    guard biometryEnrolled() else { throw MomoDeviceKeyFailure.biometryUnavailable }
    if try readItemOrNil(Self.keyAccount) != nil { throw MomoDeviceKeyFailure.alreadyExists }

    var acError: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.privateKeyUsage, .biometryCurrentSet],
        &acError)
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

    try writeItem(Self.keyAccount, key.dataRepresentation)
    if let state = currentDomainState() {
      do {
        try writeItem(Self.domainStateAccount, state)
      } catch {
        // Half a key is worse than none: without its domain state it would
        // report `invalidated` forever. Roll back.
        deleteItem(Self.keyAccount)
        throw error
      }
    }
    return key.publicKey.compressedRepresentation
  }

  // MARK: - public key

  public func publicKey() throws -> Data? {
    guard Self.secureEnclaveAvailable else { throw MomoDeviceKeyFailure.unsupported }
    guard let blob = try readItemOrNil(Self.keyAccount) else { return nil }
    do {
      return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
        .publicKey.compressedRepresentation
    } catch {
      throw MomoDeviceKeyFailure.invalidated
    }
  }

  // MARK: - sign

  /// ECDSA P-256 over SHA-256(message). Returns raw r‖s (64 bytes), the same
  /// shape WebCrypto produces. Face ID is raised with `reason`.
  public func sign(_ message: Data, reason: String) async throws -> Data {
    guard Self.secureEnclaveAvailable else { throw MomoDeviceKeyFailure.unsupported }
    guard !message.isEmpty else { throw MomoDeviceKeyFailure.failed("empty message") }
    guard let blob = try readItemOrNil(Self.keyAccount) else { throw MomoDeviceKeyFailure.absent }
    if biometryChangedSinceCreation() { throw MomoDeviceKeyFailure.invalidated }

    // Evaluate first so user-facing outcomes (cancel, lockout) arrive as clean
    // LAErrors instead of opaque enclave errors; the evaluated context is then
    // handed to the key so Face ID is not raised twice.
    let context = LAContext()
    context.localizedCancelTitle = "취소"
    do {
      _ = try await context.evaluatePolicy(
        .deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
    } catch let error as LAError {
      switch error.code {
      case .userCancel, .appCancel, .systemCancel, .userFallback:
        throw MomoDeviceKeyFailure.cancelled
      case .biometryLockout:
        throw MomoDeviceKeyFailure.lockedOut
      case .biometryNotEnrolled, .biometryNotAvailable:
        throw MomoDeviceKeyFailure.invalidated
      default:
        throw MomoDeviceKeyFailure.failed("biometry: \(error.localizedDescription)")
      }
    }

    do {
      let key = try SecureEnclave.P256.Signing.PrivateKey(
        dataRepresentation: blob, authenticationContext: context)
      return try key.signature(for: message).rawRepresentation
    } catch {
      // Face ID just succeeded, so a key that still refuses is one whose
      // biometryCurrentSet binding no longer matches the enrolled set.
      throw MomoDeviceKeyFailure.invalidated
    }
  }

  // MARK: - delete

  public func delete() {
    deleteItem(Self.keyAccount)
    deleteItem(Self.domainStateAccount)
  }

  // MARK: - biometry

  private func biometryEnrolled() -> Bool {
    var error: NSError?
    return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
  }

  /// The enrolled-biometry fingerprint. `evaluatedPolicyDomainState` is used on
  /// every OS version on purpose: mixing it with iOS 18's
  /// `domainState.biometry.stateHash` would make an OS upgrade look like a
  /// Face ID re-enrollment and invalidate every key.
  private func currentDomainState() -> Data? {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
      return nil
    }
    return context.evaluatedPolicyDomainState
  }

  /// True when the key can no longer sign because the enrolled set changed.
  /// Lockout is NOT a change (enrollment is intact), so it reads as false and
  /// `sign` reports `.lockedOut` instead.
  private func biometryChangedSinceCreation() -> Bool {
    let context = LAContext()
    var error: NSError?
    if !context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
      if let code = error.map({ LAError.Code(rawValue: $0.code) }), code == .biometryLockout {
        return false
      }
      return true  // nothing enrolled any more
    }
    guard let now = context.evaluatedPolicyDomainState else { return false }
    guard let then = try? readItemOrNil(Self.domainStateAccount) else { return true }
    return now != then
  }

  // MARK: - keychain (always the app-only group)

  private func baseQuery(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
      kSecUseDataProtectionKeychain as String: true,
    ]
  }

  private func readItemOrNil(_ account: String) throws -> Data? {
    var query = baseQuery(account)
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

  private func writeItem(_ account: String, _ data: Data) throws {
    deleteItem(account)
    var query = baseQuery(account)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    query[kSecAttrSynchronizable as String] = false
    let status = SecItemAdd(query as CFDictionary, nil)
    switch status {
    case errSecSuccess: return
    case errSecMissingEntitlement:
      throw MomoDeviceKeyFailure.misconfigured("the app is not entitled to \(accessGroup) (-34018)")
    default: throw MomoDeviceKeyFailure.failed("keychain write \(status)")
    }
  }

  private func deleteItem(_ account: String) {
    SecItemDelete(baseQuery(account) as CFDictionary)
  }
}
