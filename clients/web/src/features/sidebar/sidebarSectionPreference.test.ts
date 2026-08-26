import { afterEach, describe, expect, it } from "vitest";
import {
  SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY,
  reloadSidebarSectionPreferenceForTest,
  setSidebarSectionCollapsed,
  sidebarSectionsCollapsed,
} from "./sidebarSectionPreference";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => reloadSidebarSectionPreferenceForTest(null));

describe("sidebar section collapse preference", () => {
  it("persists a fold and restores it on the next load", () => {
    const storage = new MemoryStorage();
    reloadSidebarSectionPreferenceForTest(storage);
    expect(sidebarSectionsCollapsed()).toEqual({
      channels: false,
      dms: false,
    });

    setSidebarSectionCollapsed("channels", true, storage);
    expect(storage.getItem(SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY)).toBe(
      JSON.stringify({ channels: true, dms: false })
    );

    reloadSidebarSectionPreferenceForTest(storage);
    expect(sidebarSectionsCollapsed()).toEqual({
      channels: true,
      dms: false,
    });
  });

  it("treats unknown stored values as both-open", () => {
    const storage = new MemoryStorage();
    storage.setItem(SIDEBAR_SECTIONS_COLLAPSED_STORAGE_KEY, "old-value");
    reloadSidebarSectionPreferenceForTest(storage);
    expect(sidebarSectionsCollapsed()).toEqual({
      channels: false,
      dms: false,
    });
  });
});
