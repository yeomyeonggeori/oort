import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LINK_PREVIEW_PREFERENCE,
  LINK_PREVIEW_FOLDED_STORAGE_KEY,
  LINK_PREVIEW_STORAGE_KEY,
  linkPreviewPreference,
  migrateLinkPreviewPreference,
  reloadLinkPreviewPreferenceForTest,
  setLinkPreviewPreference,
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

  it("defaults an unset store to compact (작게), including never-toggled existing users (#4882)", () => {
    expect(DEFAULT_LINK_PREVIEW_PREFERENCE).toBe("compact");
    expect(migrateLinkPreviewPreference(null, null)).toBe("compact");
    expect(migrateLinkPreviewPreference(undefined, undefined)).toBe(
      DEFAULT_LINK_PREVIEW_PREFERENCE
    );
  });

  it("keeps a person who chose 크게 on it: the stored key wins over the new default", () => {
    expect(migrateLinkPreviewPreference("rich", null)).toBe("rich");
    const storage = new MemoryStorage();
    storage.setItem(LINK_PREVIEW_STORAGE_KEY, "rich");
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("rich");
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
    expect(linkPreviewPreference()).toBe("compact");

    setLinkPreviewPreference("rich", storage);
    expect(storage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("rich");
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("rich");

    setLinkPreviewPreference("off", storage);
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("off");

    setLinkPreviewPreference("compact", storage);
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("compact");
  });
});

describe("setLinkPreviewPreference", () => {
  it("writes even when the chosen value is already the in-memory default", () => {
    const storage = new MemoryStorage();
    reloadLinkPreviewPreferenceForTest(storage);
    expect(linkPreviewPreference()).toBe("compact");
    expect(storage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBeNull();

    setLinkPreviewPreference("compact", storage);
    expect(storage.getItem(LINK_PREVIEW_STORAGE_KEY)).toBe("compact");
    expect(linkPreviewPreference()).toBe("compact");
  });
});
