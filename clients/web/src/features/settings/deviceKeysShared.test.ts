import { describe, expect, it } from "vitest";
import { deviceKeyFingerprint } from "./deviceKeysShared";

describe("deviceKeyFingerprint", () => {
  // Same key, same string as the desktop shell's native dialog
  // (clients/desktop/src-tauri/src/device_key/payload/tests.rs FINGERPRINT_VECTOR).
  it("matches the shared case", async () => {
    expect(await deviceKeyFingerprint("A2sX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKW")).toBe(
      "5BAF F89D E7DE 5C1D 7B61"
    );
  });
});
