// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_NOTIFICATION_DENIED_MESSAGE,
  DESKTOP_NOTIFICATION_ENABLE_LABEL,
  DESKTOP_NOTIFICATION_GRANTED_LABEL,
  DESKTOP_NOTIFICATION_REQUESTING_LABEL,
  DESKTOP_NOTIFICATION_UNSUPPORTED_MESSAGE,
  DesktopNotificationGroup,
  DesktopNotificationPermissionPanel,
} from "./DesktopNotificationGroup";
import { reloadDesktopNotificationKindsForTest } from "@/features/notifications/preference";

const readPermission = vi.hoisted(() => vi.fn());
const requestPermission = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => true,
}));

vi.mock("@/features/notifications/permission", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notifications/permission")>();
  return {
    ...actual,
    readDesktopNotificationPermission: () => readPermission() as Promise<string>,
    requestDesktopNotificationPermission: () =>
      requestPermission() as Promise<string>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  readPermission.mockReset();
  requestPermission.mockReset();
  readPermission.mockResolvedValue("default");
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
});

function mount(tree: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(tree));
  return host;
}

describe("DesktopNotificationPermissionPanel", () => {
  it("shows 켜짐 when permission is granted", () => {
    const host = mount(
      createElement(DesktopNotificationPermissionPanel, {
        permission: "granted",
        requesting: false,
        onRequest: () => undefined,
      })
    );
    const panel = host.querySelector(
      '[data-testid="desktop-notifications-permission"]'
    );
    expect(panel?.getAttribute("data-state")).toBe("granted");
    expect(panel?.textContent).toContain(DESKTOP_NOTIFICATION_GRANTED_LABEL);
    expect(
      host.querySelector('[data-testid="desktop-notifications-enable"]')
    ).toBeNull();
  });

  it("shows 알림 켜기, then 요청 중, while default", () => {
    const onRequest = vi.fn();
    const host = mount(
      createElement(DesktopNotificationPermissionPanel, {
        permission: "default",
        requesting: false,
        onRequest,
      })
    );
    const button = host.querySelector(
      '[data-testid="desktop-notifications-enable"]'
    ) as HTMLButtonElement;
    expect(button.textContent).toBe(DESKTOP_NOTIFICATION_ENABLE_LABEL);
    act(() => button.click());
    expect(onRequest).toHaveBeenCalledTimes(1);

    act(() =>
      mountedRoot?.render(
        createElement(DesktopNotificationPermissionPanel, {
          permission: "default",
          requesting: true,
          onRequest,
        })
      )
    );
    const busy = host.querySelector(
      '[data-testid="desktop-notifications-enable"]'
    ) as HTMLButtonElement;
    expect(busy.textContent).toBe(DESKTOP_NOTIFICATION_REQUESTING_LABEL);
    expect(busy.getAttribute("aria-busy")).toBe("true");
  });

  it("shows the browser-settings banner when denied", () => {
    const host = mount(
      createElement(DesktopNotificationPermissionPanel, {
        permission: "denied",
        requesting: false,
        onRequest: () => undefined,
      })
    );
    expect(
      host
        .querySelector('[data-testid="desktop-notifications-permission"]')
        ?.getAttribute("data-state")
    ).toBe("denied");
    expect(
      host.querySelector('[data-testid="desktop-notifications-denied"]')
        ?.textContent
    ).toBe(DESKTOP_NOTIFICATION_DENIED_MESSAGE);
  });

  it("shows the unsupported banner for a webview without the shell", () => {
    const host = mount(
      createElement(DesktopNotificationPermissionPanel, {
        permission: "unsupported",
        requesting: false,
        onRequest: () => undefined,
      })
    );
    expect(
      host
        .querySelector('[data-testid="desktop-notifications-permission"]')
        ?.getAttribute("data-state")
    ).toBe("unsupported");
    expect(
      host.querySelector('[data-testid="desktop-notifications-unsupported"]')
        ?.textContent
    ).toBe(DESKTOP_NOTIFICATION_UNSUPPORTED_MESSAGE);
  });
});

describe("DesktopNotificationGroup", () => {
  it("turns the request button to 요청 중, then 켜짐", async () => {
    let grant: ((value: string) => void) | null = null;
    requestPermission.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          grant = resolve;
        })
    );
    const host = mount(createElement(DesktopNotificationGroup));
    await act(async () => {
      await Promise.resolve();
    });
    const button = host.querySelector(
      '[data-testid="desktop-notifications-enable"]'
    ) as HTMLButtonElement;
    expect(button.textContent).toBe(DESKTOP_NOTIFICATION_ENABLE_LABEL);

    act(() => button.click());
    expect(
      (
        host.querySelector(
          '[data-testid="desktop-notifications-enable"]'
        ) as HTMLButtonElement
      ).textContent
    ).toBe(DESKTOP_NOTIFICATION_REQUESTING_LABEL);

    await act(async () => {
      grant?.("granted");
    });
    expect(
      host
        .querySelector('[data-testid="desktop-notifications-permission"]')
        ?.getAttribute("data-state")
    ).toBe("granted");
    expect(host.textContent).toContain(DESKTOP_NOTIFICATION_GRANTED_LABEL);
  });

  it("writes a kind toggle to this-device storage", async () => {
    const host = mount(createElement(DesktopNotificationGroup));
    await act(async () => {
      await Promise.resolve();
    });
    const mention = host.querySelector(
      '[data-testid="desktop-notification-kind-mention"]'
    ) as HTMLInputElement;
    expect(mention.checked).toBe(true);
    act(() => mention.click());
    expect(mention.checked).toBe(false);
    expect(
      host.querySelector('[data-testid="desktop-notification-kind-approval"]')
    ).not.toBeNull();
    expect(host.textContent).not.toContain("준비");
  });
});
