import CryptoKit
import Foundation
import LocalAuthentication

// Runtime check of MomoDeviceKeyStore on the iOS SIMULATOR (#3026).
//
// 1. A simulator has no Secure Enclave, so the only correct behaviour is the
//    explicit "unsupported" path: every operation refuses. (Whether anything
//    reached the keychain cannot be asked here: a spawned, unsigned binary has
//    no keychain entitlement at all, so every query answers -34018 regardless.)
//    A software-key fallback would make `create()` return a key here — this
//    program then exits 1.
// 2. The decisions that need no enclave run for real: the E1 payload allowlist
//    against docs/api/human-control-signing.vectors.json (argv[1]), and the
//    biometry / enclave-failure classification behind `invalidated`.
// Run by ./run.sh.

var failures = 0
func check(_ ok: Bool, _ what: String) {
  print("\(ok ? "ok" : "FAIL"): \(what)")
  if !ok { failures += 1 }
}

func runSync(_ body: @escaping () async -> Void) {
  let sem = DispatchSemaphore(value: 0)
  Task {
    await body()
    sem.signal()
  }
  sem.wait()
}

let group = "YWQQFQM38J.app.momo.ios.devicekey"
let store = try! MomoDeviceKeyStore(accessGroup: group)

// ---- vectors ---------------------------------------------------------------
guard CommandLine.arguments.count > 1,
  let vectorData = FileManager.default.contents(atPath: CommandLine.arguments[1]),
  let vectorJSON = try? JSONSerialization.jsonObject(with: vectorData) as? [String: Any],
  let cases = vectorJSON["cases"] as? [[String: Any]]
else {
  print("FAIL: usage: device-key-sim-check <human-control-signing.vectors.json>")
  exit(1)
}
let payloads: [(String, Data)] = cases.compactMap { c in
  guard let name = c["name"] as? String, let p = c["payload"] as? String else { return nil }
  return (name, Data(p.utf8))
}
check(payloads.count == cases.count && payloads.count >= 8, "read \(payloads.count) E1 vector payloads")
func schemaOf(_ p: Data) -> String { String(decoding: p.prefix(while: { $0 != 0x0A }), as: UTF8.self) }
let v1Payloads = payloads.filter { schemaOf($0.1) == "momo.human.control.v1" }
let rootMacPayloads = payloads.filter { schemaOf($0.1) != "momo.human.control.v1" }
check(v1Payloads.count >= 6, "vectors carry \(v1Payloads.count) control.v1 payloads")
// #3096: v1 left the phone's allow-list (the server and host took v1 only
// while the phone had nothing newer). These 13-line vectors are kept as
// SHAPE samples — the allow-list reads the schema line and the line count,
// never the content — relabelled v2, the schema the phone signs input as.
// The real v2/v3 bytes are checked from the v3 vectors below.
let phonePayloads: [(String, Data)] = v1Payloads.map { name, payload in
  (name, Data(String(decoding: payload, as: UTF8.self)
    .replacingOccurrences(of: "momo.human.control.v1", with: "momo.human.control.v2").utf8))
}
check(
  Set(rootMacPayloads.map { schemaOf($0.1) }) == ["momo.human.device_endorse.v1", "momo.human.device_revoke.v1"],
  "vectors carry the root-Mac endorse/revoke payloads")
check(
  MomoDeviceKeyStore.signingSchemas == [
    "momo.human.control.v2": 13, "momo.human.control.v3": 13,
    "momo.human.control.v4": 13, "momo.human.device_rebind.v1": 7,
  ],
  "the phone allows only momo.human.control.v2/v3/v4 (13 lines) and its own device_rebind.v1 (7 lines)")

// ---- #3103: the rebind letter momo-wire printed (argv[2]) --------------------
guard CommandLine.arguments.count > 2,
  let rebindData = FileManager.default.contents(atPath: CommandLine.arguments[2]),
  let rebindJSON = try? JSONSerialization.jsonObject(with: rebindData) as? [String: Any],
  let rebindPayload = rebindJSON["payload"] as? String,
  let rebindInputs = rebindJSON["inputs"] as? [String: Any],
  let rebindKey = rebindInputs["publicKey"] as? String
else {
  print("FAIL: usage: device-key-sim-check <vectors.json> <device-rebind.vector.json>")
  exit(1)
}
let rebind = Data(rebindPayload.utf8)

// ---- 1. no enclave, no key -------------------------------------------------
check(MomoDeviceKeyStore.secureEnclaveAvailable == false, "secureEnclaveAvailable is false")
check((try? store.status()) == .unsupported, "status() == unsupported")

do {
  let key = try store.create()
  check(false, "create() refused — but it RETURNED a \(key.count)-byte key (software fallback)")
} catch let failure as MomoDeviceKeyFailure {
  check(failure == .unsupported, "create() refused with \(failure.code)")
} catch {
  check(false, "create() threw a non-typed error: \(error)")
}

do {
  _ = try store.publicKey()
  check(false, "publicKey() refused")
} catch let failure as MomoDeviceKeyFailure {
  check(failure == .unsupported, "publicKey() refused with \(failure.code)")
} catch { check(false, "publicKey() typed error") }

// A valid E1 payload gets past the payload check and stops at the enclave.
runSync {
  do {
    _ = try await store.sign(phonePayloads[0].1, reason: "시험")
    check(false, "sign(valid payload) refused")
  } catch let failure as MomoDeviceKeyFailure {
    check(failure == .unsupported, "sign(valid payload) refused with \(failure.code)")
  } catch { check(false, "sign() typed error") }
}

// A group that is not the app-only one is refused outright.
for bad in ["", "$(AppIdentifierPrefix)app.momo.ios.devicekey", "YWQQFQM38J.app.momo.ios.shared"] {
  let refused = (try? MomoDeviceKeyStore(accessGroup: bad)) == nil
  check(refused, "init refuses access group '\(bad)'")
}

// ---- 2. payload allowlist (M-3) --------------------------------------------
func rejects(_ data: Data) -> Bool {
  do {
    try MomoDeviceKeyStore.checkSigningPayload(data)
    return false
  } catch let failure as MomoDeviceKeyFailure {
    if case .payloadRejected = failure { return true }
    return false
  } catch { return false }
}

for (name, payload) in phonePayloads {
  check(!rejects(payload), "accepts vector \(name)")
}
// #3096: a real v1 statement is refused before Face ID.
for (name, payload) in v1Payloads {
  check(rejects(payload), "rejects v1 vector \(name)")
}
check(!rejects(rebind), "accepts the momo-wire device_rebind.v1 letter (7 lines)")
let rebindText = String(decoding: rebind, as: UTF8.self)
check(rejects(rebind + Data("\nx".utf8)), "rejects a rebind letter with an 8th line")
check(
  rejects(Data(rebindText.split(separator: "\n").dropLast().joined(separator: "\n").utf8)),
  "rejects a rebind letter one line short")
check(rejects(rebind + Data([0x0A])), "rejects a rebind letter with a trailing newline")
// The key signs only its own move.
check((try? MomoDeviceKeyStore.checkRebindNamesKey(rebind, publicKeyBase64: rebindKey)) != nil,
  "a rebind letter naming this key passes the own-key check")
let otherKey = (rebindKey.hasPrefix("A") ? "B" : "A") + rebindKey.dropFirst()
check(otherKey != rebindKey, "the other key differs from the letter's")
check((try? MomoDeviceKeyStore.checkRebindNamesKey(rebind, publicKeyBase64: otherKey)) == nil,
  "a rebind letter naming another key is refused")
check((try? MomoDeviceKeyStore.checkRebindNamesKey(phonePayloads[0].1, publicKeyBase64: "x")) != nil,
  "the own-key check leaves control payloads alone")
// ADR-0146 D-6/D-7: endorsements and revocations are the root Mac's to sign.
for (name, payload) in rootMacPayloads {
  check(rejects(payload), "rejects root-Mac vector \(name)")
}

let control = phonePayloads.first { $0.0.hasPrefix("control_") }!.1
let controlText = String(decoding: control, as: UTF8.self)
var mutations: [(String, Data)] = [
  ("three arbitrary bytes", Data([1, 2, 3])),
  ("empty", Data()),
  ("trailing newline", control + Data([0x0A])),
  ("extra line", control + Data("\nx".utf8)),
  ("one line short", Data(controlText.split(separator: "\n").dropLast().joined(separator: "\n").utf8)),
  ("schema v4", Data(controlText.replacingOccurrences(of: "momo.human.control.v2", with: "momo.human.control.v4").utf8)),
  ("schema with suffix", Data(controlText.replacingOccurrences(of: "momo.human.control.v2\n", with: "momo.human.control.v2x\n").utf8)),
  ("leading space", Data(" ".utf8) + control),
  ("CR line breaks", Data(controlText.replacingOccurrences(of: "\n", with: "\r\n").utf8)),
  ("NUL inside", Data(controlText.replacingOccurrences(of: "input", with: "in\u{0}put").utf8)),
  ("invalid UTF-8", control + Data([0xFF])),
  ("oversize", Data(controlText.replacingOccurrences(of: "input", with: String(repeating: "a", count: 3000)).utf8)),
  ("bare JSON", Data("{\"kind\":\"input\",\"text\":\"rm -rf\"}".utf8)),
]
// A control payload relabelled as endorse keeps 13 lines: refused by count.
mutations.append(
  ("control lines under endorse schema",
   Data(controlText.replacingOccurrences(of: "momo.human.control.v2", with: "momo.human.device_endorse.v1").utf8)))
for (name, bad) in mutations {
  check(rejects(bad), "rejects payload: \(name)")
}

// …and sign() itself refuses before touching anything.
runSync {
  do {
    _ = try await store.sign(Data([1, 2, 3]), reason: "시험")
    check(false, "sign(arbitrary bytes) refused")
  } catch let failure as MomoDeviceKeyFailure {
    if case .payloadRejected = failure {
      check(true, "sign(arbitrary bytes) refused with \(failure.code)")
    } else {
      check(false, "sign(arbitrary bytes) refused with \(failure.code), not PAYLOAD_REJECTED")
    }
  } catch { check(false, "sign() typed error") }
}

// ---- 3. invalidated only on proof (M-1, M-2) -------------------------------
typealias Store = MomoDeviceKeyStore
check(Store.health(canEvaluateError: nil) == .intact, "health: Face ID usable → intact")
check(Store.health(canEvaluateError: .biometryLockout) == .intact, "health: lockout → intact")
check(
  Store.health(canEvaluateError: .biometryNotAvailable) == .biometryUnavailable,
  "health: Face ID off for the app / unavailable → biometryUnavailable, NOT invalidated")
check(Store.health(canEvaluateError: .biometryNotEnrolled) == .invalidated, "health: nothing enrolled → invalidated")
check(Store.health(canEvaluateError: .passcodeNotSet) == .invalidated, "health: passcode removed → invalidated")
check(
  Store.health(canEvaluateError: .notInteractive) == .biometryUnavailable,
  "health: other LAError → biometryUnavailable, NOT invalidated")

check(Store.failure(evaluating: .userCancel) == .cancelled, "evaluate: userCancel → cancelled")
check(Store.failure(evaluating: .userFallback) == .cancelled, "evaluate: userFallback → cancelled")
check(Store.failure(evaluating: .biometryLockout) == .lockedOut, "evaluate: lockout → lockedOut")
check(
  Store.failure(evaluating: .biometryNotAvailable) == .biometryUnavailable,
  "evaluate: biometryNotAvailable → biometryUnavailable, NOT invalidated")
check(Store.failure(evaluating: .biometryNotEnrolled) == .invalidated, "evaluate: notEnrolled → invalidated")
check(Store.failure(evaluating: .passcodeNotSet) == .invalidated, "evaluate: passcodeNotSet → invalidated")

check(
  Store.failure(afterAuthenticatedEnclaveError: "x", fingerprint: .same) == .failed("enclave signing: x"),
  "enclave refused after Face ID, fingerprint same → failed, NOT invalidated")
check(
  Store.failure(afterAuthenticatedEnclaveError: "x", fingerprint: .unknown) == .failed("enclave signing: x"),
  "enclave refused after Face ID, fingerprint unknown → failed, NOT invalidated")
check(
  Store.failure(afterAuthenticatedEnclaveError: "x", fingerprint: .changed) == .invalidated,
  "enclave refused after Face ID, fingerprint changed → invalidated")

// Fingerprints are compared only with the API that produced them.
typealias FP = MomoDeviceKeyStore.Fingerprint
let a = Data([0xAA, 0xBB]), b = Data([0xCC])
let legacyA = FP.tagged(FP.legacyTag, a), modernA = FP.tagged(FP.domainStateTag, a)
check(FP.tagged(FP.legacyTag, nil) == nil && FP.tagged(FP.legacyTag, Data()) == nil, "fingerprint: nothing to tag → nil")
check(FP.compare(stored: legacyA, legacyNow: a, domainStateNow: b) == .same, "fingerprint: legacy stored vs legacy now same")
check(FP.compare(stored: legacyA, legacyNow: b, domainStateNow: a) == .changed, "fingerprint: legacy stored vs legacy now changed (domainState ignored)")
check(FP.compare(stored: modernA, legacyNow: b, domainStateNow: a) == .same, "fingerprint: domainState stored vs domainState now same (legacy ignored)")
check(FP.compare(stored: modernA, legacyNow: a, domainStateNow: b) == .changed, "fingerprint: domainState stored vs domainState now changed")
check(FP.compare(stored: modernA, legacyNow: a, domainStateNow: nil) == .unknown, "fingerprint: no value from the same API → unknown")
check(FP.compare(stored: nil, legacyNow: a, domainStateNow: a) == .unknown, "fingerprint: nothing stored → unknown")
check(FP.compare(stored: Data([0x09]) + a, legacyNow: a, domainStateNow: a) == .unknown, "fingerprint: unknown tag → unknown")

// ---- 4. #3106: the refresh key (argv[3], momo-wire's refresh_proof vector) ----
guard CommandLine.arguments.count > 3,
  let refreshData = FileManager.default.contents(atPath: CommandLine.arguments[3]),
  let refreshJSON = try? JSONSerialization.jsonObject(with: refreshData) as? [String: Any],
  let refreshPayload = refreshJSON["payload"] as? String,
  let refreshSignature = refreshJSON["signature"] as? String,
  let refreshHash = refreshJSON["refreshTokenSha256"] as? String,
  let refreshInputs = refreshJSON["inputs"] as? [String: Any],
  let rWorkspace = refreshInputs["workspaceId"] as? String,
  let rMember = refreshInputs["memberId"] as? String,
  let rKey = refreshInputs["publicKey"] as? String,
  let rToken = refreshInputs["refreshToken"] as? String,
  let rNonce = refreshInputs["nonce"] as? String,
  let rAt = (refreshInputs["signedAtMs"] as? NSNumber)?.int64Value,
  let rKeyData = Data(base64Encoded: rKey)
else {
  print("FAIL: usage: device-key-sim-check <vectors.json> <device-rebind.vector.json> <refresh-proof.vector.json>")
  exit(1)
}
typealias RK = MomoRefreshKeyStore
let refresh = Data(refreshPayload.utf8)

// The bytes are momo-wire's, byte for byte.
check(RK.tokenSha256Hex(rToken) == refreshHash, "refresh: token hash equals momo-wire's")
let built = try? RK.proofBytes(
  workspaceId: rWorkspace, memberId: rMember, publicKey: rKeyData, refreshToken: rToken,
  nonce: rNonce, signedAtMs: rAt)
check(built == refresh, "refresh: proofBytes equals the momo-wire vector payload")
// And momo-wire's signature verifies over them under the vector's key (a
// public key only — no software private key is constructed anywhere).
if let pub = try? P256.Signing.PublicKey(compressedRepresentation: rKeyData),
  let sigData = Data(base64Encoded: refreshSignature),
  let sig = try? P256.Signing.ECDSASignature(rawRepresentation: sigData)
{
  check(pub.isValidSignature(sig, for: built ?? Data()), "refresh: the vector signature verifies over proofBytes")
} else {
  check(false, "refresh: vector key/signature decode")
}
for (name, bad) in [
  ("uppercase workspace", { try RK.proofBytes(workspaceId: "ABCDEF00-0000-4000-8000-000000000001", memberId: rMember, publicKey: rKeyData, refreshToken: rToken, nonce: rNonce, signedAtMs: rAt) }),
  ("empty token", { try RK.proofBytes(workspaceId: rWorkspace, memberId: rMember, publicKey: rKeyData, refreshToken: "", nonce: rNonce, signedAtMs: rAt) }),
  ("zero time", { try RK.proofBytes(workspaceId: rWorkspace, memberId: rMember, publicKey: rKeyData, refreshToken: rToken, nonce: rNonce, signedAtMs: 0) }),
  ("short key", { try RK.proofBytes(workspaceId: rWorkspace, memberId: rMember, publicKey: rKeyData.dropLast(), refreshToken: rToken, nonce: rNonce, signedAtMs: rAt) }),
] as [(String, () throws -> Data)] {
  check((try? bad()) == nil, "refresh: proofBytes refuses \(name)")
}

// Cross-sabotage: each key signs only its own statements.
func refreshRejects(_ data: Data, _ key: String) -> Bool {
  (try? RK.checkProofPayload(data, publicKeyBase64: key)) == nil
}
check(!refreshRejects(refresh, rKey), "refresh key: accepts the vector proof naming its key")
check(refreshRejects(refresh, otherKey), "refresh key: refuses a proof naming another key")
check(refreshRejects(refresh + Data([0x0A]), rKey), "refresh key: refuses a trailing newline")
for (name, payload) in phonePayloads {
  check(refreshRejects(payload, rKey), "refresh key: refuses instruction \(name)")
}
check(refreshRejects(rebind, rKey), "refresh key: refuses a rebind letter")
check(rejects(refresh), "instruction key: refuses a refresh proof (not in signingSchemas)")
check(MomoDeviceKeyStore.signingSchemas[RK.schema] == nil, "instruction key: refresh_proof.v1 is not an allowed schema")

// No biometry on the refresh key; the instruction key keeps it (sabotage:
// add .biometryCurrentSet here and background refreshes fail — RED).
check(RK.accessFlags == [.privateKeyUsage], "refresh key: access control is privateKeyUsage only")
check(RK.service != "app.momo.ios.devicekey" && RK.keyAccount != "p256-signing-v1",
  "refresh key: a different item from the instruction key")

// No enclave, no key, no software fallback.
let refreshStore = try! RK(accessGroup: group)
do {
  let proof = try refreshStore.prove(workspaceId: rWorkspace, memberId: rMember, refreshToken: rToken, signedAtMs: rAt)
  check(false, "refresh key: prove() refused — but it RETURNED a proof by \(proof.publicKey) (software fallback)")
} catch let failure as MomoDeviceKeyFailure {
  check(failure == .unsupported, "refresh key: prove() refused with \(failure.code)")
} catch { check(false, "refresh key: prove() typed error") }
for bad in ["", "YWQQFQM38J.app.momo.ios.shared"] {
  check((try? RK(accessGroup: bad)) == nil, "refresh key: init refuses access group '\(bad)'")
}

// ---- #3128: control v3 (argv[4], docs/api/human-control-signing-v3.vectors.json)
// Every v3 payload passes the allow-list, and every recorded signature
// (WebCrypto, CryptoKit, Secure Enclave) verifies over those bytes here too —
// the Swift third of the Rust · TS · Swift cross test. A permission payload
// whose preview-hash-bearing content line is swapped no longer verifies.
guard CommandLine.arguments.count > 4,
  let v3Data = FileManager.default.contents(atPath: CommandLine.arguments[4]),
  let v3JSON = try? JSONSerialization.jsonObject(with: v3Data) as? [String: Any],
  let v3Cases = v3JSON["cases"] as? [[String: Any]]
else {
  print("FAIL: usage: device-key-sim-check <vectors.json> <rebind.json> <refresh.json> <v3 vectors.json>")
  exit(1)
}
check(v3Cases.count == 7, "v3: read \(v3Cases.count) vector cases")
var v3Permissions = 0
for c in v3Cases {
  guard let name = c["name"] as? String, let p = c["payload"] as? String,
    let sigs = c["signatures"] as? [[String: Any]]
  else {
    check(false, "v3: a case without name/payload/signatures")
    continue
  }
  let payload = Data(p.utf8)
  check(schemaOf(payload) == "momo.human.control.v3", "v3: \(name) is a control.v3 payload")
  check(!rejects(payload), "v3: accepts \(name)")
  var verified = 0
  for sig in sigs {
    guard let keyB64 = sig["public_key"] as? String, let keyData = Data(base64Encoded: keyB64),
      let sigB64 = sig["signature"] as? String, let sigData = Data(base64Encoded: sigB64),
      let pub = try? P256.Signing.PublicKey(compressedRepresentation: keyData),
      let ecdsa = try? P256.Signing.ECDSASignature(rawRepresentation: sigData)
    else { continue }
    if pub.isValidSignature(ecdsa, for: payload) { verified += 1 }
  }
  check(verified == sigs.count && verified >= 3, "v3: \(name) — \(verified)/\(sigs.count) signatures verify")
  if let content = c["content"] as? [String: Any], content["kind"] as? String == "permission" {
    v3Permissions += 1
    // Swap the last line (content_sha256 over a body naming another preview).
    var lines = p.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    lines[lines.count - 1] = String(repeating: "0", count: 64)
    let swapped = Data(lines.joined(separator: "\n").utf8)
    let stillVerifies = sigs.contains { sig in
      guard let keyData = Data(base64Encoded: sig["public_key"] as? String ?? ""),
        let sigData = Data(base64Encoded: sig["signature"] as? String ?? ""),
        let pub = try? P256.Signing.PublicKey(compressedRepresentation: keyData),
        let ecdsa = try? P256.Signing.ECDSASignature(rawRepresentation: sigData)
      else { return false }
      return pub.isValidSignature(ecdsa, for: swapped)
    }
    check(!stillVerifies, "v3: \(name) — a swapped content line does not verify")
  }
}
check(v3Permissions == 2, "v3: two permission cases")

print(failures == 0 ? "PASS" : "FAILED (\(failures))")
exit(failures == 0 ? 0 : 1)
