import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceName,
  fallbackHandle,
  handleFieldError,
  isValidHandle,
} from "./fallbackHandle";

describe("fallbackHandle (server fallback_handle 동형)", () => {
  it("derives the handle the way the server does", () => {
    expect(fallbackHandle("ada@example.com")).toBe("ada");
    expect(fallbackHandle("ada.lovelace@example.com")).toBe("ada-lovelace");
    expect(fallbackHandle("ada...lovelace@example.com")).toBe("ada-lovelace");
    expect(fallbackHandle(".ada.@example.com")).toBe("ada");
    expect(fallbackHandle("a@example.com")).toBe("member");
    expect(fallbackHandle("모모@example.com")).toBe("member");
    expect(fallbackHandle(`${"a".repeat(40)}@example.com`).length).toBe(32);
    expect(
      fallbackHandle("ada.lovelace.the.first.of.her.name.x@example.com").length
    ).toBe(32);
  });

  it("trims a trailing dash left by the 32-char cap", () => {
    const email = `${"a".repeat(32)}.x@example.com`;
    const handle = fallbackHandle(email);
    expect(handle.endsWith("-")).toBe(false);
    expect(isValidHandle(handle)).toBe(true);
  });

  it("treats a bare handle as a local part", () => {
    expect(fallbackHandle("seongjae")).toBe("seongjae");
    expect(fallbackHandle("demo")).toBe("demo");
  });
});

describe("S1 field defaults", () => {
  it("clears the seed workspace name and keeps any other name", () => {
    expect(defaultWorkspaceName("momo Demo Workspace")).toBe("");
    expect(defaultWorkspaceName(undefined)).toBe("");
    expect(defaultWorkspaceName("새벽")).toBe("새벽");
  });

  it("uses the server handle 400 sentence for a bad handle", () => {
    expect(handleFieldError("!")).toBe(
      "handle must be 2-32 chars of a-z, 0-9, _ or -"
    );
    expect(handleFieldError("seongjae")).toBeNull();
  });
});
