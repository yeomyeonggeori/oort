import ExpoModulesCore
import Foundation

// =============================================================================
// MomoDeviceKeyNative — the JS surface of MomoDeviceKeyStore (issue #3026).
//
// Everything that crosses to JS is public: a status word, the compressed SEC1
// public key and raw r‖s signatures, all base64. The enclave handle stays in
// the keychain and the private key stays in the enclave; nothing here can
// return either, because MomoDeviceKeyStore has no API that yields them.
//
// Errors reject with `code` = MomoDeviceKeyFailure.code, which
// src/deviceKey/native.ts maps to a typed DeviceKeyError.
// =============================================================================

public class MomoDeviceKeyNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MomoDeviceKeyNative")

    Constant("secureEnclaveAvailable") { MomoDeviceKeyStore.secureEnclaveAvailable }

    AsyncFunction("status") { () throws -> String in
      try momoDeviceKeyRun { try momoDeviceKeyStore().status().rawValue }
    }

    AsyncFunction("create") { () throws -> String in
      try momoDeviceKeyRun { try momoDeviceKeyStore().create().base64EncodedString() }
    }

    AsyncFunction("publicKey") { () throws -> String? in
      try momoDeviceKeyRun { try momoDeviceKeyStore().publicKey()?.base64EncodedString() }
    }

    AsyncFunction("sign") { (messageBase64: String, reason: String) async throws -> String in
      guard let message = Data(base64Encoded: messageBase64) else {
        throw momoDeviceKeyException(.failed("message is not base64"))
      }
      do {
        return try await momoDeviceKeyStore().sign(message, reason: reason).base64EncodedString()
      } catch let failure as MomoDeviceKeyFailure {
        throw momoDeviceKeyException(failure)
      }
    }

    AsyncFunction("remove") { () throws in
      try momoDeviceKeyRun { try momoDeviceKeyStore().delete() }
    }

    // #3106: the REFRESH key (MomoRefreshKeyStore) — a separate enclave key
    // with no biometry. Typed fields in, a proof out: there is no "sign these
    // bytes" for this key, and it signs only `momo.human.refresh_proof.v1`.
    AsyncFunction("signRefreshProof") {
      (workspaceId: String, memberId: String, refreshToken: String, signedAtMs: Double) throws
        -> [String: Any] in
      guard let at = Int64(exactly: signedAtMs.rounded()) else {
        throw momoDeviceKeyException(.payloadRejected("signedAtMs is not an integer"))
      }
      return try momoDeviceKeyRun {
        let proof = try momoRefreshKeyStore().prove(
          workspaceId: workspaceId, memberId: memberId, refreshToken: refreshToken, signedAtMs: at)
        return [
          "publicKey": proof.publicKey,
          "nonce": proof.nonce,
          "signedAtMs": Double(proof.signedAtMs),
          "signature": proof.signature,
        ]
      }
    }
  }
}

private func momoRefreshKeyStore() throws -> MomoRefreshKeyStore {
  let raw = Bundle.main.object(forInfoDictionaryKey: MomoDeviceKeyStore.accessGroupInfoKey) as? String
  return try MomoRefreshKeyStore(accessGroup: raw ?? "")
}

/// The access group comes from the app's Info.plist, where Xcode expands the
/// team prefix at build time. The extension's Info.plist does not carry the key
/// at all, so even linked into it this would refuse (`.misconfigured`).
private func momoDeviceKeyStore() throws -> MomoDeviceKeyStore {
  let raw = Bundle.main.object(forInfoDictionaryKey: MomoDeviceKeyStore.accessGroupInfoKey) as? String
  return try MomoDeviceKeyStore(accessGroup: raw ?? "")
}

private func momoDeviceKeyRun<T>(_ body: () throws -> T) throws -> T {
  do {
    return try body()
  } catch let failure as MomoDeviceKeyFailure {
    throw momoDeviceKeyException(failure)
  }
}

private func momoDeviceKeyException(_ failure: MomoDeviceKeyFailure) -> Exception {
  Exception(name: "MomoDeviceKeyError", description: failure.message, code: failure.code)
}
