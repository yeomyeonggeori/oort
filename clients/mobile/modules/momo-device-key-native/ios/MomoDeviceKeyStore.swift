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
// Hardening before stage 2 (review of #3043, M-1..M-4):
//
//   5. Only instruction payloads are signed (M-3). `sign` refuses any message
//      that is not exactly a 13-line `momo.human.control.v1`/`v2`/`v3` payload with
//      no control character, so the key is not an oracle for arbitrary bytes.
//      Endorsements and revocations (`device_endorse.v1`/`device_revoke.v1`)
//      are signed by the root Mac only (ADR-0146 D-6/D-7) and refused here
//      (server-rust/crates/momo-wire/src/human_control.rs,
//      docs/api/human-control-signing.vectors.json). The one other letter is
//      the key's own move onto a new sign-in, `momo.human.device_rebind.v1`
//      (7 lines, #3103; ADR-0146 D-7 증보 #3097), and only when its public-key
//      line is THIS key's (`checkRebindNamesKey`): the key signs its own move,
//      never another key's.
//
//   6. `invalidated` is reported only on proof (M-1, M-2). The enclave is the
//      arbiter: a key is invalidated when the enclave rejects its handle, when
//      the biometry it was bound to is gone (not enrolled / no passcode), or
//      when Face ID has just SUCCEEDED and the enclave still refuses while the
//      enrollment fingerprint differs from the one taken at creation. A Face ID
//      permission switched off, a transient enclave error or a fingerprint that
//      moved on its own (the SDK warns it "can change exceptionally between
//      major OS versions") is never reported as `invalidated` — the caller
//      deletes on `invalidated`, and deleting forces a root-Mac re-approval.
//
//   7. `create` and `delete` are serialized, and the key handle is written
//      add-only, so two concurrent `create` calls cannot leave the device
//      holding a key other than the one whose public half was returned (M-4).
// =============================================================================

public enum MomoDeviceKeyStatus: String {
  /// No Secure Enclave on this device (every simulator). Nothing can be created.
  case unsupported
  /// Face ID cannot be used right now. With no key: nothing is enrolled, so a
  /// `biometryCurrentSet` key cannot be created. With a key: Face ID is off
  /// for this app or temporarily unavailable — the key is intact and signs
  /// again once Face ID is back. The caller must NOT delete it.
  case biometryUnavailable
  /// No key yet.
  case absent
  /// A key exists and nothing proves it unusable. (A Face ID re-enrollment is
  /// proven at the next `sign`, which then fails with `.invalidated`.)
  case ready
  /// A key exists but can never sign again: the enclave rejects its handle, or
  /// the biometry it was bound to is gone. The caller deletes it and creates a
  /// new one, which then needs a fresh endorsement from the root Mac
  /// (ADR-0146 D-6).
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
  case payloadRejected(String)
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
    case .payloadRejected: return "DEVICE_KEY_PAYLOAD_REJECTED"
    case .failed: return "DEVICE_KEY_FAILED"
    }
  }

  public var message: String {
    switch self {
    case .unsupported: return "This device has no Secure Enclave; no device key can exist here."
    case .biometryUnavailable: return "Face ID is not available to this app right now."
    case .misconfigured(let why): return "Device key access group is misconfigured: \(why)"
    case .alreadyExists: return "A device key already exists. Delete it first."
    case .absent: return "No device key exists."
    case .invalidated: return "The device key can no longer sign (biometry enrollment changed)."
    case .cancelled: return "The user cancelled Face ID."
    case .lockedOut: return "Biometry is locked out; unlock the phone with its passcode first."
    case .payloadRejected(let why): return "Refusing to sign: \(why)"
    case .failed(let why): return "Device key operation failed: \(why)"
    }
  }
}

/// What the biometry state says about an EXISTING key, before any Face ID.
public enum MomoDeviceKeyHealth: Equatable {
  /// Nothing proves the key unusable.
  case intact
  /// Face ID is off or temporarily unavailable; the key itself is untouched.
  case biometryUnavailable
  /// The biometry the key was bound to is gone.
  case invalidated
}

/// The enrollment fingerprint now, compared with the one taken at creation.
public enum MomoDeviceKeyFingerprintComparison: Equatable {
  case same
  case changed
  /// No stored fingerprint, or no current value from the same API.
  case unknown
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
  /// Tagged fingerprint (see `Fingerprint`). v1 held an untagged
  /// `evaluatedPolicyDomainState`; it is never read, only deleted.
  static let fingerprintAccount = "biometry-fingerprint-v2"
  static let retiredFingerprintAccounts = ["biometry-domain-state-v1"]

  /// `create`, `delete` and the post-sign fingerprint refresh run one at a
  /// time, process-wide (M-4). `sign` itself is never queued: it waits on Face ID.
  private static let mutations = DispatchQueue(label: "app.momo.ios.devicekey.mutations")

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

  // MARK: - signing payloads (M-3)

  /// The E1 schema lines this key may sign, with each payload's exact line
  /// count (momo-wire `human_control.rs` `signed_bytes`). Instructions only:
  /// `device_endorse.v1`/`device_revoke.v1` are the root Mac's (ADR-0146
  /// D-6/D-7), so the phone key refuses them. `control.v2` (#3027 E7, #3028
  /// E8) is what the phone signs: the same 13-line frame, a spawn binding the
  /// tool, the channel and a resume's session. v1 stays for input/permission
  /// statements the server still accepts. `control.v3` (#3118 → #3128) is
  /// what an allow is signed as: the same 13-line frame, its permission body
  /// binding the hash of the host's preview the card checked and showed.
  public static let signingSchemas: [String: Int] = [
    "momo.human.control.v1": 13,
    "momo.human.control.v2": 13,
    "momo.human.control.v3": 13,
    "momo.human.device_rebind.v1": 7,
  ]
  /// #3103 (momo-wire `DEVICE_REBIND_SCHEMA_V1`): the key moves itself onto
  /// the caller's new sign-in. Line 5 (index 4) is the key's own public key.
  public static let rebindSchema = "momo.human.device_rebind.v1"

  /// A rebind letter must name this key's own public key (compressed SEC1,
  /// base64) on its public-key line. Any other payload passes untouched.
  public static func checkRebindNamesKey(_ message: Data, publicKeyBase64: String) throws {
    let text = String(decoding: message, as: UTF8.self)
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.first.map(String.init) == rebindSchema else { return }
    guard lines.count == 7, String(lines[4]) == publicKeyBase64 else {
      throw MomoDeviceKeyFailure.payloadRejected("a rebind letter names another key")
    }
  }
  /// Largest payload accepted. The E1 control vectors top out at 384 bytes;
  /// every field is an id, a number or a hex digest.
  public static let maxSigningPayloadBytes = 2048

  /// Accepts only an E1 payload: UTF-8 lines joined by `\n` with no other
  /// control character (momo-wire `no_control`), whose first line is an
  /// allowed schema and whose line count is exactly that schema's — so a
  /// trailing newline or an appended line is refused too. Free instruction
  /// text never appears in the signed bytes; it is hashed into
  /// `content_sha256`.
  public static func checkSigningPayload(_ message: Data) throws {
    guard !message.isEmpty else { throw MomoDeviceKeyFailure.payloadRejected("empty message") }
    guard message.count <= maxSigningPayloadBytes else {
      throw MomoDeviceKeyFailure.payloadRejected("longer than \(maxSigningPayloadBytes) bytes")
    }
    guard let text = String(data: message, encoding: .utf8) else {
      throw MomoDeviceKeyFailure.payloadRejected("not UTF-8")
    }
    guard
      !text.unicodeScalars.contains(where: {
        $0 != "\n" && $0.properties.generalCategory == .control
      })
    else {
      throw MomoDeviceKeyFailure.payloadRejected("control character other than a line break")
    }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
    guard let expected = signingSchemas[String(lines[0])] else {
      throw MomoDeviceKeyFailure.payloadRejected("first line is not an allowed schema")
    }
    guard lines.count == expected else {
      throw MomoDeviceKeyFailure.payloadRejected("\(lines[0]) has \(expected) lines, got \(lines.count)")
    }
  }

  // MARK: - classification (M-1, M-2) — pure, so sim-check runs it

  /// `canEvaluatePolicy` failed (or not: `nil`) — what that says about an
  /// existing key. Only a biometry set that is GONE invalidates a
  /// `biometryCurrentSet` key; a switched-off permission or unavailable
  /// sensor does not.
  public static func health(canEvaluateError code: LAError.Code?) -> MomoDeviceKeyHealth {
    guard let code else { return .intact }
    switch code {
    case .biometryNotEnrolled, .passcodeNotSet:
      return .invalidated
    case .biometryLockout:
      // Enrollment is intact; `sign` reports `.lockedOut`.
      return .intact
    default:
      // .biometryNotAvailable covers "Face ID switched off for oort" in
      // Settings as well as a sensor that is temporarily unavailable.
      return .biometryUnavailable
    }
  }

  /// `evaluatePolicy` (Face ID) failed with `code`.
  public static func failure(evaluating code: LAError.Code) -> MomoDeviceKeyFailure {
    switch code {
    case .userCancel, .appCancel, .systemCancel, .userFallback:
      return .cancelled
    case .biometryLockout:
      return .lockedOut
    case .biometryNotEnrolled, .passcodeNotSet:
      return .invalidated
    case .biometryNotAvailable:
      return .biometryUnavailable
    default:
      return .failed("biometry error \(code.rawValue)")
    }
  }

  /// Face ID has just SUCCEEDED and the enclave still refused to open the
  /// handle or sign. That alone is not proof — a transient enclave error or a
  /// context invalidated by backgrounding looks the same — so it is
  /// `invalidated` only when the enrollment fingerprint has changed too.
  public static func failure(
    afterAuthenticatedEnclaveError detail: String,
    fingerprint: MomoDeviceKeyFingerprintComparison
  ) -> MomoDeviceKeyFailure {
    fingerprint == .changed ? .invalidated : .failed("enclave signing: \(detail)")
  }

  // MARK: - enrollment fingerprint

  /// A stored fingerprint is tagged with the API that produced it and is only
  /// ever compared with the same API: `evaluatedPolicyDomainState` (deprecated
  /// in iOS 18) and `domainState.biometry.stateHash` are different values, so
  /// mixing them would make an OS upgrade look like a Face ID re-enrollment.
  public enum Fingerprint {
    public static let legacyTag: UInt8 = 0x01  // evaluatedPolicyDomainState, iOS < 18
    public static let domainStateTag: UInt8 = 0x02  // domainState.biometry.stateHash, iOS 18+

    public static func tagged(_ tag: UInt8, _ raw: Data?) -> Data? {
      guard let raw, !raw.isEmpty else { return nil }
      return Data([tag]) + raw
    }

    /// `stored` is the tagged value from creation; `legacyNow`/`domainStateNow`
    /// are the untagged values each API reports now (nil = not available).
    public static func compare(
      stored: Data?, legacyNow: Data?, domainStateNow: Data?
    ) -> MomoDeviceKeyFingerprintComparison {
      guard let stored, stored.count > 1 else { return .unknown }
      let raw = stored.dropFirst()
      let now: Data?
      switch stored[stored.startIndex] {
      case legacyTag: now = legacyNow
      case domainStateTag: now = domainStateNow
      default: return .unknown
      }
      guard let now, !now.isEmpty else { return .unknown }
      return Data(raw) == now ? .same : .changed
    }
  }

  // MARK: - status

  /// Throws only `.misconfigured`/`.failed` (the keychain itself refused): a
  /// missing entitlement must not read as "no key yet".
  public func status() throws -> MomoDeviceKeyStatus {
    guard Self.secureEnclaveAvailable else { return .unsupported }
    guard let blob = try readItemOrNil(Self.keyAccount) else {
      return biometryCheck().error == nil ? .absent : .biometryUnavailable
    }
    // Opening the handle needs no authentication; an enclave that rejects it
    // outright (a blob restored onto other hardware — which ThisDeviceOnly
    // should already prevent) will never sign with it.
    guard (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)) != nil else {
      return .invalidated
    }
    switch Self.health(canEvaluateError: biometryCheck().error) {
    case .intact: return .ready
    case .biometryUnavailable: return .biometryUnavailable
    case .invalidated: return .invalidated
    }
  }

  // MARK: - create

  /// Returns the compressed SEC1 public key (33 bytes).
  public func create() throws -> Data {
    guard Self.secureEnclaveAvailable else { throw MomoDeviceKeyFailure.unsupported }
    return try Self.mutations.sync { try createLocked() }
  }

  private func createLocked() throws -> Data {
    let check = biometryCheck()
    guard check.error == nil else { throw MomoDeviceKeyFailure.biometryUnavailable }
    // Without a fingerprint a later enclave refusal could never be told apart
    // from a transient error; refuse rather than make half a key (N-7).
    guard let fingerprint = Self.currentFingerprint(check.context) else {
      throw MomoDeviceKeyFailure.failed("no biometry fingerprint available")
    }
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

    // Add-only: never replace a handle someone else just wrote (M-4).
    try addItem(Self.keyAccount, key.dataRepresentation)
    do {
      try writeItem(Self.fingerprintAccount, fingerprint)
    } catch {
      // Half a key is worse than none. Roll back.
      deleteItem(Self.keyAccount)
      throw error
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
  /// shape WebCrypto produces. Face ID is raised with `reason`. `message` must
  /// be an E1 payload (`checkSigningPayload`).
  public func sign(_ message: Data, reason: String) async throws -> Data {
    // The payload check is pure input validation and runs first, so the
    // simulator (no enclave) still proves it is wired in (sim-check).
    try Self.checkSigningPayload(message)
    guard Self.secureEnclaveAvailable else { throw MomoDeviceKeyFailure.unsupported }
    guard let blob = try readItemOrNil(Self.keyAccount) else { throw MomoDeviceKeyFailure.absent }
    // A rebind letter moves THIS key: its public-key line must be ours. The
    // public half needs no authentication, so this runs before Face ID.
    if message.starts(with: Data((Self.rebindSchema + "\n").utf8)) {
      guard let own = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob) else {
        throw MomoDeviceKeyFailure.invalidated
      }
      try Self.checkRebindNamesKey(
        message, publicKeyBase64: own.publicKey.compressedRepresentation.base64EncodedString())
    }

    // Evaluate first so user-facing outcomes (cancel, lockout) arrive as clean
    // LAErrors instead of opaque enclave errors; the evaluated context is then
    // handed to the key so Face ID is not raised twice. No reuse window:
    // a fresh context per signature.
    let context = LAContext()
    context.localizedCancelTitle = "취소"
    // biometryCurrentSet never accepts the passcode; do not offer it (N-4).
    context.localizedFallbackTitle = ""
    do {
      _ = try await context.evaluatePolicy(
        .deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
    } catch let error as LAError {
      throw Self.failure(evaluating: error.code)
    }

    let signature: Data
    do {
      let key = try SecureEnclave.P256.Signing.PrivateKey(
        dataRepresentation: blob, authenticationContext: context)
      signature = try key.signature(for: message).rawRepresentation
    } catch {
      throw Self.failure(
        afterAuthenticatedEnclaveError: error.localizedDescription,
        fingerprint: try compareFingerprint(context))
    }
    // The enclave just signed under biometryCurrentSet, so the enrollment is
    // the one the key was bound to: re-baseline a fingerprint that moved on
    // its own (OS upgrade, or a v1/legacy value on iOS 18+). Best effort.
    refreshFingerprint(context)
    return signature
  }

  // MARK: - delete

  public func delete() {
    Self.mutations.sync {
      deleteItem(Self.keyAccount)
      deleteItem(Self.fingerprintAccount)
      for account in Self.retiredFingerprintAccounts { deleteItem(account) }
    }
  }

  // MARK: - biometry

  /// A fresh context that has run `canEvaluatePolicy` (which is what fills in
  /// its domain state), and the LAError code when it said no.
  private func biometryCheck() -> (context: LAContext, error: LAError.Code?) {
    let context = LAContext()
    var error: NSError?
    if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
      return (context, nil)
    }
    return (context, LAError.Code(rawValue: error?.code ?? LAError.Code.biometryNotAvailable.rawValue) ?? .biometryNotAvailable)
  }

  /// The tagged fingerprint to store from `context`: the iOS 18 API where it
  /// exists, the legacy one below.
  ///
  /// The legacy header documents its value as set "when canEvaluatePolicy
  /// succeeds for a biometric policy"; the iOS 18 header only says `stateHash`
  /// is nil when nothing is enrolled and does not say whether
  /// `canEvaluatePolicy` alone fills it. So a nil `stateHash` falls back to the
  /// legacy value rather than refusing `create()` on every iOS 18+ phone
  /// (runtime-unverified); the first successful signature then re-baselines
  /// to the iOS 18 value.
  private static func currentFingerprint(_ context: LAContext) -> Data? {
    if #available(iOS 18.0, macOS 15.0, *),
      let modern = Fingerprint.tagged(Fingerprint.domainStateTag, context.domainState.biometry.stateHash)
    {
      return modern
    }
    return Fingerprint.tagged(Fingerprint.legacyTag, legacyDomainState(context))
  }

  /// Only for fingerprints taken below iOS 18 (tag 0x01): the one API that can
  /// be compared with them. Deployment target is 16.4, so this is not a
  /// deprecation warning; raising it to 18 retires this path (N-2).
  private static func legacyDomainState(_ context: LAContext) -> Data? {
    context.evaluatedPolicyDomainState
  }

  private func compareFingerprint(_ context: LAContext) throws -> MomoDeviceKeyFingerprintComparison {
    let stored = try readItemOrNil(Self.fingerprintAccount)
    var domainStateNow: Data?
    if #available(iOS 18.0, macOS 15.0, *) {
      domainStateNow = context.domainState.biometry.stateHash
    }
    let legacyNow =
      stored?.first == Fingerprint.legacyTag ? Self.legacyDomainState(context) : nil
    return Fingerprint.compare(stored: stored, legacyNow: legacyNow, domainStateNow: domainStateNow)
  }

  private func refreshFingerprint(_ context: LAContext) {
    guard let now = Self.currentFingerprint(context) else { return }
    Self.mutations.sync {
      guard (try? readItemOrNil(Self.keyAccount)) != nil,
        (try? readItemOrNil(Self.fingerprintAccount)) != now
      else { return }
      try? writeItem(Self.fingerprintAccount, now)
    }
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

  /// Adds without replacing: a duplicate is `.alreadyExists`, never an overwrite.
  private func addItem(_ account: String, _ data: Data) throws {
    var query = baseQuery(account)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
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

  /// Replaces. Only for the fingerprint, never for the key handle.
  private func writeItem(_ account: String, _ data: Data) throws {
    deleteItem(account)
    try addItem(account, data)
  }

  private func deleteItem(_ account: String) {
    SecItemDelete(baseQuery(account) as CFDictionary)
  }
}
