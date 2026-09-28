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
let phonePayloads = payloads.filter { schemaOf($0.1) == "momo.human.control.v1" }
let rootMacPayloads = payloads.filter { schemaOf($0.1) != "momo.human.control.v1" }
check(phonePayloads.count >= 6, "vectors carry \(phonePayloads.count) control.v1 payloads")
check(
  Set(rootMacPayloads.map { schemaOf($0.1) }) == ["momo.human.device_endorse.v1", "momo.human.device_revoke.v1"],
  "vectors carry the root-Mac endorse/revoke payloads")
check(
  MomoDeviceKeyStore.signingSchemas == ["momo.human.control.v1": 13, "momo.human.control.v2": 13],
  "the phone allows only momo.human.control.v1/v2 (13 lines)")

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
  ("schema v3", Data(controlText.replacingOccurrences(of: "momo.human.control.v1", with: "momo.human.control.v3").utf8)),
  ("schema with suffix", Data(controlText.replacingOccurrences(of: "momo.human.control.v1\n", with: "momo.human.control.v1x\n").utf8)),
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
   Data(controlText.replacingOccurrences(of: "momo.human.control.v1", with: "momo.human.device_endorse.v1").utf8)))
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

print(failures == 0 ? "PASS" : "FAILED (\(failures))")
exit(failures == 0 ? 0 : 1)
