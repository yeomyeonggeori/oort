import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayGlyph, type CatalogEmoji } from "./catalog";
import {
  EMOJI_SKIN_STORAGE_KEY,
  getEmojiSkinTone,
  resetEmojiSkinToneForTests,
  setEmojiSkinTone,
} from "./skinToneStore";

const memory = new Map<string, string>();

beforeEach(() => {
  memory.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  });
  resetEmojiSkinToneForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const waving: CatalogEmoji = {
  glyph: "👋",
  name: "waving hand",
  shortcodes: ["wave"],
  keywords: ["hello"],
  category: "people",
  skins: ["👋🏻", "👋🏼", "👋🏽", "👋🏾", "👋🏿"],
};

describe("emoji skin tone store", () => {
  it("defaults to no modifier", () => {
    expect(getEmojiSkinTone()).toBe(0);
    expect(displayGlyph(waving, getEmojiSkinTone())).toBe("👋");
  });

  it("persists a global tone and applies it to skinned glyphs", () => {
    setEmojiSkinTone(3);
    expect(getEmojiSkinTone()).toBe(3);
    expect(memory.get(EMOJI_SKIN_STORAGE_KEY)).toBe("3");
    expect(displayGlyph(waving, getEmojiSkinTone())).toBe("👋🏽");
  });

  it("leaves unskinned emoji unchanged", () => {
    setEmojiSkinTone(5);
    expect(
      displayGlyph(
        {
          glyph: "🎉",
          name: "party popper",
          shortcodes: ["tada"],
          keywords: [],
          category: "activity",
        },
        5
      )
    ).toBe("🎉");
  });
});
