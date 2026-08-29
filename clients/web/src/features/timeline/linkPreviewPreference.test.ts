import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LINK_PREVIEW_PREFERENCE,
  LINK_PREVIEW_FOLDED_STORAGE_KEY,
  LINK_PREVIEW_STORAGE_KEY,
  linkPreviewPreference,
  migrateLinkPreviewPreference,
  reloadLinkPreviewPreferenceForTest,
  setLinkPreviewPreference,
  unfurlCardLayout,
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

describe("migrateLinkPreviewPreference", () => {
  it("maps the boolean-era hidden value to off", () => {
    expect(migrateLinkPreviewPreference(null, "true")).toBe("off");
  });

  it("maps the boolean-era visible value to compact", () => {
    expect(migrateLinkPreviewPreference(null, "false")).toBe("compact");
  });

  it("maps unknown boolean-era values to compact (they used to show the card)", () => {
    expect(migrateLinkPreviewPreference(null, "old-value")).toBe("compact");
  });

  it("defaults a fresh store to rich", () => {
    expect(migrateLinkPreviewPreference(null, null)).toBe("rich");
    expect(migrateLinkPreviewPreference(undefined, undefined)).toBe(
      DEFAULT_LINK_PREVIEW_PREFERENCE
    );
  });

  it("lets a valid 3-value key win over a leftover boolean key", () => {
    expect(migrateLinkPreviewPreference("rich", "true")).toBe("rich");
    expect(migrateLinkPreviewPreference("compact", "true")).toBe("compact");
    expect(migrateLinkPreviewPreference("off", "false")).toBe("off");
  });
});

describe("boolean → 3-value round trip", () => {
  it("restores off from folded=true and keeps it after reload", () => {
    const storage = new MemoryStorage();
    storage.setItem(LINK_PREVIEW_FOLDED_STORAGE_KEY, "true");
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("off");
    expect(storage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("off");

    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("off");
  });

  it("restores compact from folded=false and keeps it after reload", () => {
    const storage = new MemoryStorage();
    storage.setItem(LINK_PREVIEW_FOLDED_STORAGE_KEY, "false");
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("compact");
    expect(storage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("compact");

    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("compact");
  });

  it("writes the 3-value key and reloads it", () => {
    const storage = new MemoryStorage();
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("rich");

    setLinkPreviewPreference("compact", storage);
    expect(storage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("compact");
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("compact");

    setLinkPreviewPreference("off", storage);
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("off");

    setLinkPreviewPreference("rich", storage);
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("rich");
  });
});

describe("unfurlCardLayout", () => {
  it("never paints a rich hero without a ready image", () => {
    expect(unfurlCardLayout("rich", false)).toBe("compact");
    expect(unfurlCardLayout("rich", true)).toBe("rich");
    expect(unfurlCardLayout("compact", true)).toBe("compact");
    expect(unfurlCardLayout("compact", false)).toBe("compact");
    expect(unfurlCardLayout("off", true)).toBe("none");
    expect(unfurlCardLayout("off", false)).toBe("none");
  });
});
