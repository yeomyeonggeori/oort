import Foundation

// Runtime check of MomoDeviceKeyStore on the iOS SIMULATOR (#3026).
// A simulator has no Secure Enclave, so the only correct behaviour is the
// explicit "unsupported" path: every operation refuses. (Whether anything reached
// the keychain cannot be asked here: a spawned, unsigned binary has no keychain
// entitlement at all, so every query answers -34018 regardless.) A software-key fallback would make `create()` return a key
// here — this program then exits 1. Run by ./run.sh.

var failures = 0
func check(_ ok: Bool, _ what: String) {
  print("\(ok ? "ok" : "FAIL"): \(what)")
  if !ok { failures += 1 }
}

let group = "YWQQFQM38J.app.momo.ios.devicekey"
let store = try! MomoDeviceKeyStore(accessGroup: group)

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

let sem = DispatchSemaphore(value: 0)
Task {
  do {
    _ = try await store.sign(Data([1, 2, 3]), reason: "시험")
    check(false, "sign() refused")
  } catch let failure as MomoDeviceKeyFailure {
    check(failure == .unsupported, "sign() refused with \(failure.code)")
  } catch { check(false, "sign() typed error") }
  sem.signal()
}
sem.wait()

// A group that is not the app-only one is refused outright.
for bad in ["", "$(AppIdentifierPrefix)app.momo.ios.devicekey", "YWQQFQM38J.app.momo.ios.shared"] {
  let refused = (try? MomoDeviceKeyStore(accessGroup: bad)) == nil
  check(refused, "init refuses access group '\(bad)'")
}

print(failures == 0 ? "PASS" : "FAILED (\(failures))")
exit(failures == 0 ? 0 : 1)
