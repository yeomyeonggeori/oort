import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_NOTIFICATION_KINDS,
  DESKTOP_NOTIFICATION_STORAGE_KEY,
  desktopNotificationKinds,
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => reloadDesktopNotificationKindsForTest(null));

describe("desktop notification kinds preference", () => {
  it("defaults both real fire-path kinds on", () => {
    expect(desktopNotificationKinds()).toEqual(DEFAULT_DESKTOP_NOTIFICATION_KINDS);
    expect(Object.keys(desktopNotificationKinds()).sort()).toEqual([
      "approval",
      "mention",
      "reminder",
    ]);
  });

  it("persists a kind off and restores it on the next load", () => {
    const storage = new MemoryStorage();
    reloadDesktopNotificationKindsForTest(storage);
    setDesktopNotificationKind("mention", false, storage);
    expect(JSON.parse(storage.getItem(DESKTOP_NOTIFICATION_STORAGE_KEY) ?? "")).toEqual({
      mention: false,
      approval: true,
      reminder: true,
    });

    reloadDesktopNotificationKindsForTest(storage);
    expect(desktopNotificationKinds()).toEqual({
      mention: false,
      approval: true,
      reminder: true,
    });
  });

  it("treats missing, corrupt, or partial records as the on default", () => {
    const storage = new MemoryStorage();
    storage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, "not-json");
    reloadDesktopNotificationKindsForTest(storage);
    expect(desktopNotificationKinds()).toEqual(DEFAULT_DESKTOP_NOTIFICATION_KINDS);

    storage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, JSON.stringify({ mention: false }));
    reloadDesktopNotificationKindsForTest(storage);
    expect(desktopNotificationKinds()).toEqual({
      mention: false,
      approval: true,
      reminder: true,
    });
  });
});
