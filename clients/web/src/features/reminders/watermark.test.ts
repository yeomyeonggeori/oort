// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  readReminderWatermark,
  REMINDER_WATERMARK_STORAGE_KEY,
  writeReminderWatermark,
} from "./watermark";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const WS = "ws-1";

afterEach(() => {
  localStorage.removeItem(REMINDER_WATERMARK_STORAGE_KEY);
});

describe("reminder watermark store", () => {
  it("returns null before the first check and round-trips per workspace", () => {
    const storage = new MemoryStorage();
    expect(readReminderWatermark(WS, storage)).toBeNull();
    writeReminderWatermark(WS, 1_800_000_000_000, storage);
    expect(readReminderWatermark(WS, storage)).toBe(1_800_000_000_000);
    expect(readReminderWatermark("other", storage)).toBeNull();
    expect(REMINDER_WATERMARK_STORAGE_KEY.startsWith("momo.web.")).toBe(true);
  });

  it("treats corrupt JSON as a first look", () => {
    const storage = new MemoryStorage();
    storage.setItem(REMINDER_WATERMARK_STORAGE_KEY, "not-json");
    expect(readReminderWatermark(WS, storage)).toBeNull();
  });
});
