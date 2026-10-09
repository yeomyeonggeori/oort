// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationRules } from "@momo/core/features/settings/notificationRules";
import { ApiError } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { NotificationRulesSection } from "./NotificationRulesSection";
import { reloadDesktopNotificationKindsForTest } from "@/features/notifications/preference";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const fetchNotificationRules = vi.hoisted(() => vi.fn());
const putNotificationRules = vi.hoisted(() => vi.fn());
const patchNotificationRules = vi.hoisted(() => vi.fn());

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
    patchNotificationRules: (workspaceId: string, patch: Partial<NotificationRules>) =>
      patchNotificationRules(workspaceId, patch) as Promise<NotificationRules>,
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

/**
 * The server as #3012 made it: one stored rule per member. PUT replaces it
 * whole; PATCH merges the named fields into what is stored when it lands.
 */
let stored: NotificationRules = { dnd: false, mentionOverridesMute: false };

beforeEach(() => {
  fetchNotificationRules.mockReset();
  putNotificationRules.mockReset();
  patchNotificationRules.mockReset();
  stored = { dnd: false, mentionOverridesMute: false };
  fetchNotificationRules.mockImplementation(async () => ({ ...stored }));
  putNotificationRules.mockImplementation(
    async (_workspaceId: string, rules: NotificationRules) => {
      stored = { dnd: rules.dnd, mentionOverridesMute: rules.mentionOverridesMute };
      return { ...stored };
    }
  );
  patchNotificationRules.mockImplementation(
    async (_workspaceId: string, patch: Partial<NotificationRules>) => {
      stored = { ...stored, ...patch };
      return { ...stored };
    }
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
  it("writes the DND toggle as a one-field PATCH (#3042)", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="notification-rules-dnd"]')
      ).not.toBeNull();
    });
    expect(fetchNotificationRules).toHaveBeenCalledWith(WS);

    const dnd = host.querySelector(
      '[data-testid="notification-rules-dnd"]'
    ) as HTMLButtonElement;
    await act(async () => {
      dnd.click();
    });
    await vi.waitFor(() => {
      expect(patchNotificationRules).toHaveBeenCalledTimes(1);
    });
    expect(patchNotificationRules).toHaveBeenCalledWith(WS, { dnd: true });
    expect(putNotificationRules).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const now = host.querySelector(
        '[data-testid="notification-rules-dnd"]'
      ) as HTMLButtonElement;
      expect(now.getAttribute("aria-checked")).toBe("true");
    });
  });

  // #3042 race regression. This panel read the rule, then the phone changed the
  // OTHER switch. A toggle here must not write the stale read back over it.
  // Before the fix the save was a whole-object PUT of this panel's snapshot and
  // the phone's change was erased.
  it("keeps a switch another device changed after this panel read the rule", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    // Another device: the phone turns the pause on while this panel shows it off.
    stored = { ...stored, dnd: true };

    const mention = host.querySelector(
      '[data-testid="notification-rules-mention"]'
    ) as HTMLButtonElement;
    expect(mention.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      mention.click();
    });
    await vi.waitFor(() => {
      expect(stored.mentionOverridesMute).toBe(true);
    });
    // The phone's pause survived this panel's write…
    expect(stored).toEqual({ dnd: true, mentionOverridesMute: true });
    // …and the panel now shows the server's answer, not its stale snapshot.
    const dnd = host.querySelector('[data-testid="notification-rules-dnd"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(dnd.getAttribute("aria-checked")).toBe("true"));
  });

  it("names the server-vs-device split in copy", async () => {
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="notification-rules"]')
      ).not.toBeNull();
    });
    expect(host.textContent).toContain(
      "알림 일시 중지와 멘션 예외는 서버에 하나만 있어요."
    );
    expect(host.textContent).toContain(
      "OS 알림을 종류별로 끄는 선택은 이 기기에만 저장돼요."
    );
    expect(host.textContent).not.toContain("하나만 있는 규칙이에요");
    const mention = host.querySelector(
      '[data-testid="desktop-notification-kind-mention"]'
    ) as HTMLButtonElement;
    expect(mention.getAttribute("role")).toBe("switch");
    expect(mention.disabled).toBe(true);
    const reason = host.querySelector(
      '[data-testid="desktop-notifications-unsupported"]'
    );
    expect(mention.getAttribute("aria-describedby")).toContain(reason!.id);
  });

  // 403은 서버 운영자 권한이 아니라 「활성 사람 멤버만」이다(notification_rules.rs). 운영자 안내문을
  // 붙이지 않고, 다시 시도해도 실패가 보장된 단추도 없다.
  it("403이면 사람 멤버만 정할 수 있다고 말하고 다시 시도 단추를 두지 않는다", async () => {
    fetchNotificationRules.mockRejectedValue(new ApiError(403, "active human membership required"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-error"]')).not.toBeNull();
    });
    const error = host.querySelector('[data-testid="notification-rules-error"]')!;
    expect(error.textContent).toContain("사람 멤버만 알림 규칙을 정할 수 있어요.");
    expect(error.querySelector("button")).toBeNull();
    expect(host.querySelector('[data-testid="operator-notice"]')).toBeNull();
    expect(host.querySelector('[data-testid="notification-rules-dnd"]')).toBeNull();
  });

  it("다른 실패는 다시 불러오기 단추를 주고 누르면 다시 묻는다", async () => {
    fetchNotificationRules.mockRejectedValueOnce(new ApiError(500, "boom"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-error"] button')).not.toBeNull();
    });
    await act(async () => {
      (host.querySelector('[data-testid="notification-rules-error"] button') as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    expect(fetchNotificationRules).toHaveBeenCalledTimes(2);
  });

  it("오프라인이면 두 스위치가 잠기고 이유 문장을 가리킨다", async () => {
    const host = await mountSection(true);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    const reason = host.querySelector('[data-testid="notification-rules-offline"]')!;
    for (const id of ["notification-rules-dnd", "notification-rules-mention"]) {
      const sw = host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;
      expect(sw.disabled).toBe(true);
      expect(sw.getAttribute("aria-describedby")).toContain(reason.id);
    }
    await act(async () => {
      (host.querySelector('[data-testid="notification-rules-dnd"]') as HTMLButtonElement).click();
    });
    expect(patchNotificationRules).not.toHaveBeenCalled();
  });

  it("저장이 실패하면 스위치를 되돌리고 이유를 보인다", async () => {
    patchNotificationRules.mockRejectedValue(new ApiError(500, "boom"));
    const host = await mountSection();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-dnd"]')).not.toBeNull();
    });
    const dnd = () => host.querySelector('[data-testid="notification-rules-dnd"]') as HTMLButtonElement;
    await act(async () => {
      dnd().click();
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="notification-rules-save-error"]')).not.toBeNull();
    });
    expect(dnd().getAttribute("aria-checked")).toBe("false");
  });
});
