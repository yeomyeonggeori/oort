// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_NOTIFICATION_DEFAULT_DETAIL,
  BROWSER_NOTIFICATION_DENIED_MESSAGE,
  BROWSER_NOTIFICATION_GRANTED_DETAIL,
  BROWSER_NOTIFICATION_UNSUPPORTED_MESSAGE,
  DesktopNotificationGroup,
} from "./DesktopNotificationGroup";
import { reloadDesktopNotificationKindsForTest } from "@/features/notifications/preference";

// 브라우저 탭의 설정 구역 (#3340). 셸 없음, Notification API만 가짜로 둔다.

vi.mock("@/lib/tauri", () => ({ isDesktop: () => false }));

class FakeNotification {
  static permission: NotificationPermission = "default";
  static next: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = FakeNotification.next;
    return FakeNotification.next;
  });
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  FakeNotification.permission = "default";
  FakeNotification.next = "granted";
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  vi.unstubAllGlobals();
});

async function mountGroup(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  await act(async () => {
    mountedRoot?.render(createElement(DesktopNotificationGroup));
    await Promise.resolve();
  });
  return host;
}

const state = (host: HTMLElement) =>
  host.querySelector('[data-testid="desktop-notifications-permission"]')?.getAttribute("data-state");

describe("DesktopNotificationGroup in a browser tab (#3340)", () => {
  it("default: shows the opt-in button and does NOT ask until it is clicked", async () => {
    const host = await mountGroup();
    expect(state(host)).toBe("default");
    expect(host.textContent).toContain(BROWSER_NOTIFICATION_DEFAULT_DETAIL);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    const button = host.querySelector('[data-testid="desktop-notifications-enable"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(state(host)).toBe("granted");
  });

  it("granted: shows 켜짐 and the browser sentence", async () => {
    FakeNotification.permission = "granted";
    const host = await mountGroup();
    expect(state(host)).toBe("granted");
    expect(host.textContent).toContain(BROWSER_NOTIFICATION_GRANTED_DETAIL);
    expect(host.querySelector('[data-testid="desktop-notifications-enable"]')).toBeNull();
  });

  it("denied: explains how to unblock in the browser, no button", async () => {
    FakeNotification.permission = "denied";
    const host = await mountGroup();
    expect(state(host)).toBe("denied");
    expect(host.textContent).toContain(BROWSER_NOTIFICATION_DENIED_MESSAGE);
    expect(host.textContent).toContain("사이트 설정");
    expect(host.querySelector('[data-testid="desktop-notifications-enable"]')).toBeNull();
  });

  it("a request the person dismisses leaves the button available", async () => {
    FakeNotification.next = "default";
    const host = await mountGroup();
    const button = host.querySelector('[data-testid="desktop-notifications-enable"]') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(state(host)).toBe("default");
    expect(host.querySelector('[data-testid="desktop-notifications-enable"]')).not.toBeNull();
  });

  it("unsupported browser: says so and locks the toggles", async () => {
    vi.stubGlobal("Notification", undefined);
    const host = await mountGroup();
    expect(state(host)).toBe("unsupported");
    expect(host.textContent).toContain(BROWSER_NOTIFICATION_UNSUPPORTED_MESSAGE);
    const mention = host.querySelector('[data-testid="desktop-notification-kind-mention"]') as HTMLInputElement;
    expect(mention.disabled).toBe(true);
  });

  it("same defaults as the desktop (DM off); no dock column; desktop-only kinds are labelled", async () => {
    FakeNotification.permission = "granted";
    const host = await mountGroup();
    const box = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
    expect(box("desktop-notification-kind-mention").checked).toBe(true);
    expect(box("desktop-notification-kind-approval").checked).toBe(true);
    expect(box("desktop-notification-kind-dm").checked).toBe(false);
    expect(box("desktop-notification-kind-dm").disabled).toBe(false);
    expect(host.querySelector('[data-testid="desktop-notification-dock-badge"]')).toBeNull();
    expect(host.querySelector('[data-testid="desktop-notification-dock-dm"]')).toBeNull();
    expect(host.querySelector('[data-testid="desktop-notification-kind-pane-waiting"]')).toBeNull();
    expect(host.textContent).toContain("데스크탑 전용");
    expect(host.querySelectorAll("thead th")).toHaveLength(3);
  });
});
