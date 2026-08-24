import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMOJI_FREQUENCY_STORAGE_KEY,
  frequentEmojis,
  getEmojiFrequency,
  recordEmojiUse,
  resetEmojiFrequencyForTests,
} from "./frequencyStore";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetEmojiFrequencyForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("emoji frequency store", () => {
  const seed = ["👍", "✅", "🙏", "🎉"] as const;

  it("returns the curated seed when nothing has been used", () => {
    expect(frequentEmojis(4, seed)).toEqual(["👍", "✅", "🙏", "🎉"]);
  });

  it("promotes by count, not by recency", () => {
    recordEmojiUse("🎉");
    recordEmojiUse("👍");
    recordEmojiUse("👍");
    recordEmojiUse("🎉");
    recordEmojiUse("🎉");
    // 🎉 used last would win a recency sort; frequency keeps 🎉 first by count 3>2.
    expect(frequentEmojis(4, seed)[0]).toBe("🎉");
    expect(getEmojiFrequency("🎉")).toBe(3);
    expect(getEmojiFrequency("👍")).toBe(2);
  });

  it("persists counts to localStorage", () => {
    recordEmojiUse("🙏");
    expect(JSON.parse(memory.get(EMOJI_FREQUENCY_STORAGE_KEY)!)).toEqual({
      "🙏": 1,
    });
  });

  it("breaks frequency ties by glyph, never by last-used order", () => {
    recordEmojiUse("🙏");
    recordEmojiUse("👍");
    expect(frequentEmojis(2, seed)).toEqual(["👍", "🙏"]);
  });
});
