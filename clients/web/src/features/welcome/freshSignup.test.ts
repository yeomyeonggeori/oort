// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearFreshSignup,
  markFreshSignup,
  peekFreshSignup,
} from "./freshSignup";

const KEY = "oort.freshSignup.v1";
const SAMPLE = {
  workspaceId: "00000000-0000-7000-8000-000000000001",
  memberId: "00000000-0000-7000-8000-000000000101",
};

afterEach(() => {
  sessionStorage.removeItem(KEY);
});

describe("freshSignup seam", () => {
  it("round trip: mark, peek without consuming, clear", () => {
    expect(peekFreshSignup()).toBeNull();
    markFreshSignup(SAMPLE);
    expect(peekFreshSignup()).toEqual(SAMPLE);
    expect(peekFreshSignup()).toEqual(SAMPLE);
    clearFreshSignup();
    expect(peekFreshSignup()).toBeNull();
  });

  it("corrupt JSON is read as absent and removed", () => {
    sessionStorage.setItem(KEY, "{not-json");
    expect(peekFreshSignup()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("object missing ids is read as absent and removed", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ workspaceId: SAMPLE.workspaceId }));
    expect(peekFreshSignup()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("missing storage returns null and does not throw", () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      "sessionStorage"
    );
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage locked");
      },
    });
    try {
      expect(peekFreshSignup()).toBeNull();
      expect(() => markFreshSignup(SAMPLE)).not.toThrow();
      expect(() => clearFreshSignup()).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "sessionStorage", original);
      }
    }
  });
});
