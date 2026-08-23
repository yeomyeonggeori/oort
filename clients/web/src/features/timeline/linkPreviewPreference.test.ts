import { afterEach, describe, expect, it } from "vitest";
import {
  LINK_PREVIEW_FOLDED_STORAGE_KEY,
  linkPreviewsFolded,
  reloadLinkPreviewPreferenceForTest,
  setLinkPreviewsFolded,
} from "./linkPreviewPreference";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => reloadLinkPreviewPreferenceForTest(null));

describe("link preview preference", () => {
  it("persists folding and restores it on the next load", () => {
    const storage = new MemoryStorage();
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewsFolded()).toBe(false);

    setLinkPreviewsFolded(true, storage);
    expect(storage.getItem(LINK_PREVIEW_FOLDED_STORAGE_KEY)).toBe("true");

    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewsFolded()).toBe(true);
  });

  it("treats unknown stored values as the visible default", () => {
    const storage = new MemoryStorage();
    storage.setItem(LINK_PREVIEW_FOLDED_STORAGE_KEY, "old-value");
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewsFolded()).toBe(false);
  });
});
