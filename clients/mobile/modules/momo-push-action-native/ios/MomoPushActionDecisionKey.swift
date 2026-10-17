import CryptoKit
import Foundation

// =============================================================================
// The decision's idempotency key (#3931, ADR-0204 D6; the I1 note of the
// push_action server review, PR #3977).
//
// `client_decision_id` is the server's idempotency key for a decision: the same
// key and the same verdict answer the original receipt (a second tap, a retry
// after a lost answer, is one decision), the same key and the other verdict is
// a 409. It is unique PER WORKSPACE and the replay lookup runs BEFORE the
// permission checks. So a key anybody can compute is a key anybody can squat: a
// channel member who learned a notification's request id could decide anything
// under the key the victim's tap is about to use, and the victim's own tap would
// answer `idempotency_conflict`.
//
// So the key is derived from the notification's request identifier and the
// action — which makes it the same on every tap of that button, with no store
// to keep — AND from a secret that never leaves this phone's app-only keychain
// group (`MomoPushActionKeychain.deviceSecret()`). A 256-bit secret in a hash
// means nobody else can name the key before the tap sends it.
//
// ## Why this file is separate
//
// It is the one place this module imports CryptoKit, and it only HASHES:
// SHA-256, nothing keyed and nothing that decrypts. The export-compliance
// declaration in Info.plist (`ITSAppUsesNonExemptEncryption = false`) rests on
// the phone's cryptography being OS-provided, signing, or hashing, and
// `__tests__/projectShape.test.ts` holds this file to "hash only" by name. A
// second CryptoKit import anywhere else in this module fails that test.
// =============================================================================

enum MomoPushActionDecisionKey {
  /// A different construction would be a different key space. Bumping this
  /// string is how a future change of the recipe stays apart from this one.
  static let domain = "momo.push-action.decision.v1"

  /// What `MomoPushActionKeychain` generates. Anything shorter is not a secret
  /// worth the name, so `derive` refuses it instead of hashing it.
  static let minimumSecretLength = 16

  /// A UUID string (the server types the key as one): the first 16 bytes of
  ///
  ///     SHA-256( domain 0x00 secret len‖request-id len‖action len‖approval-id )
  ///
  /// with RFC 9562 version 8 ("custom") and the variant bits set. The secret is
  /// first and fixed-length, and each variable field carries a 4-byte big-endian
  /// length, so no two different inputs can be written as the same byte string.
  /// Truncating to 128 bits (122 after the fixed bits) also means the output is
  /// not a hash state anyone could extend.
  ///
  /// Nil for a secret that is too short to be one.
  static func derive(
    secret: Data,
    requestIdentifier: String,
    action: String,
    approvalID: String
  ) -> String? {
    guard secret.count >= minimumSecretLength else { return nil }

    var input = Data(domain.utf8)
    input.append(0)
    input.append(secret)
    for field in [requestIdentifier, action, approvalID.lowercased()] {
      let bytes = Data(field.utf8)
      var length = UInt32(bytes.count).bigEndian
      withUnsafeBytes(of: &length) { input.append(contentsOf: $0) }
      input.append(bytes)
    }

    var bytes = Array(SHA256.hash(data: input).prefix(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    let chars = Array(hex)
    func part(_ range: Range<Int>) -> String { String(chars[range]) }
    return [part(0..<8), part(8..<12), part(12..<16), part(16..<20), part(20..<32)]
      .joined(separator: "-")
  }
}
