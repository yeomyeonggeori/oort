// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationRules } from "@momo/core/features/settings/notificationRules";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { NotificationRulesSection } from "./NotificationRulesSection";
import { reloadDesktopNotificationKindsForTest } from "@/features/notifications/preference";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const fetchNotificationRules = vi.hoisted(() => vi.fn());
const putNotificationRules = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@momo/core/features/settings/notificationRules")
    >();
  return {
    ...actual,
    fetchNotificationRules: (workspaceId: string) =>
      fetchNotificationRules(workspaceId) as Promise<NotificationRules>,
    putNotificationRules: (workspaceId: string, rules: NotificationRules) =>
      putNotificationRules(workspaceId, rules) as Promise<NotificationRules>,
  };
});

vi.mock("@/lib/tauri", () => ({
  isDesktop: () => false,
}));

vi.mock("@/features/notifications/permission", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/notifications/permission")>();
  return {
    ...actual,
    readDesktopNotificationPermission: () => Promise.resolve("unsupported"),
    requestDesktopNotificationPermission: () => Promise.resolve("unsupported"),
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
  fetchNotificationRules.mockReset();
  putNotificationRules.mockReset();
  fetchNotificationRules.mockResolvedValue({
    dnd: false,
    mentionOverridesMute: false,
  });
  putNotificationRules.mockImplementation(
    async (_workspaceId: string, rules: NotificationRules) => rules
  );
  localStorage.clear();
  reloadDesktopNotificationKindsForTest(localStorage);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  reloadDesktopNotificationKindsForTest(null);
  vi.unstubAllGlobals();
});

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

async function mountSection(offline = false): Promise<HTMLElement> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(NotificationRulesSection, { offline })
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

describe("NotificationRulesSection DND regression", () => {
  it("keeps the server DND PUT on the workspace-rule toggle", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="notification-rules-dnd"]')
      ).not.toBeNull();
    });
    expect(fetchNotificationRules).toHaveBeenCalledWith(WS);

    const dnd = host.querySelector(
      '[data-testid="notification-rules-dnd"]'
    ) as HTMLInputElement;
    await act(async () => {
      dnd.click();
    });
    await vi.waitFor(() => {
      expect(putNotificationRules).toHaveBeenCalledTimes(1);
    });
    expect(putNotificationRules).toHaveBeenCalledWith(WS, {
      dnd: true,
      mentionOverridesMute: false,
    });
  });

  it("names the server-vs-device split in copy", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="notification-rules"]')
      ).not.toBeNull();
    });
    expect(host.textContent).toContain(
      "방해 금지와 멘션 예외는 서버에 하나만 있습니다."
    );
    expect(host.textContent).toContain(
      "데스크톱 알림을 종류별로 끄는 선택은 이 기기에만 저장됩니다."
    );
    expect(host.textContent).not.toContain("하나만 있는 규칙입니다");
    const mention = host.querySelector(
      '[data-testid="desktop-notification-kind-mention"]'
    ) as HTMLInputElement;
    expect(mention.disabled).toBe(true);
    const reason = host.querySelector(
      '[data-testid="desktop-notifications-unsupported"]'
    );
    expect(mention.getAttribute("aria-describedby")).toContain(reason!.id);
  });
});
