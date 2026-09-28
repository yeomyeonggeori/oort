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
  }
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
