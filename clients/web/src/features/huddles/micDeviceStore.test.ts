import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HUDDLE_MIC_STORAGE_KEY,
  readHuddleMicDeviceId,
  resetHuddleMicDeviceForTests,
  writeHuddleMicDeviceId,
} from "./micDeviceStore";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetHuddleMicDeviceForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("huddle mic device store", () => {
  it("stores a deviceId under the v1 key", () => {
    writeHuddleMicDeviceId("mic-2");
    expect(memory.get(HUDDLE_MIC_STORAGE_KEY)).toBe("mic-2");
    expect(readHuddleMicDeviceId()).toBe("mic-2");
  });

  it("treats an empty choice as the default and does not persist it", () => {
    writeHuddleMicDeviceId("mic-2");
    writeHuddleMicDeviceId("");
    expect(memory.has(HUDDLE_MIC_STORAGE_KEY)).toBe(false);
    expect(readHuddleMicDeviceId()).toBeNull();
  });
});
