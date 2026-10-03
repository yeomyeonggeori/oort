// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ isDesktop: () => false }));

import {
  readBrowserPermission,
  requestBrowserPermission,
  setBrowserOpenHandler,
  showBrowserNotification,
} from "./browserNotify";

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = "granted";
    return "granted" as NotificationPermission;
  });
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions
  ) {
    FakeNotification.instances.push(this);
  }
}

beforeEach(() => {
  FakeNotification.permission = "default";
  FakeNotification.instances = [];
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBrowserOpenHandler(null);
});

describe("browser permission", () => {
  it("maps the API's three values and never asks by reading", () => {
    expect(readBrowserPermission()).toBe("default");
    FakeNotification.permission = "granted";
    expect(readBrowserPermission()).toBe("granted");
    FakeNotification.permission = "denied";
    expect(readBrowserPermission()).toBe("denied");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("is unsupported when the browser has no Notification API", () => {
    vi.stubGlobal("Notification", undefined);
    expect(readBrowserPermission()).toBe("unsupported");
  });

  it("asks only when requestBrowserPermission is called", async () => {
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await expect(requestBrowserPermission()).resolves.toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("supports the legacy callback form of requestPermission", async () => {
    FakeNotification.requestPermission.mockImplementationOnce(((cb?: () => void) => {
      FakeNotification.permission = "denied";
      cb?.();
      return undefined;
    }) as never);
    await expect(requestBrowserPermission()).resolves.toBe("denied");
  });
});

describe("showBrowserNotification", () => {
  it("shows nothing without a grant", async () => {
    await expect(showBrowserNotification("t", "b")).resolves.toBe(false);
    FakeNotification.permission = "denied";
    await expect(showBrowserNotification("t", "b")).resolves.toBe(false);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("click focuses the tab, routes to the target and closes the banner", async () => {
    FakeNotification.permission = "granted";
    const open = vi.fn();
    setBrowserOpenHandler(open);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    await expect(
      showBrowserNotification("곽성재", "본문", { kind: "mention", route: "/c/abc" })
    ).resolves.toBe(true);
    const banner = FakeNotification.instances[0]!;
    expect(banner.options).toMatchObject({ body: "본문", tag: "oort-mention" });
    banner.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("/c/abc");
    expect(banner.close).toHaveBeenCalled();
  });

  it("a throwing constructor is a normal refusal, not an error", async () => {
    FakeNotification.permission = "granted";
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function () {
          throw new TypeError("Illegal constructor");
        },
        { permission: "granted" }
      )
    );
    await expect(showBrowserNotification("t")).resolves.toBe(false);
  });
});
