// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { SettingsRoute } from "./SettingsRoute";

vi.mock("@momo/core/features/auth/linkedDevices", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/auth/linkedDevices")>();
  return {
    ...actual,
    listLinkedDevices: vi.fn(async () => ({ devices: [] })),
    revokeLinkedDevice: vi.fn(),
  };
});

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const navigate = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock("./AiLinkSection", () => ({
  AiLinkSection: () => createElement("div", { "data-testid": "section-ai" }),
}));
vi.mock("./WorkHostSection", () => ({
  WorkHostSection: () => createElement("div", { "data-testid": "section-code" }),
}));
vi.mock("./WorkspaceSection", () => ({
  WorkspaceSection: () =>
    createElement("div", { "data-testid": "section-workspace" }),
}));
vi.mock("./UsageSection", () => ({
  UsageSection: () => createElement("div", { "data-testid": "section-usage" }),
}));
vi.mock("./InviteSection", () => ({
  InviteSection: () =>
    createElement("div", { "data-testid": "section-members" }),
}));
vi.mock("./NotificationRulesSection", () => ({
  NotificationRulesSection: () =>
    createElement("div", { "data-testid": "section-notifications" }),
}));
vi.mock("./AppearanceSection", () => ({
  AppearanceSection: () =>
    createElement("div", { "data-testid": "section-appearance" }),
}));
vi.mock("./LinkPreviewSection", () => ({
  LinkPreviewSection: () =>
    createElement("div", { "data-testid": "section-link-previews" }),
}));
vi.mock("@/features/updates/UpdateSection", () => ({
  UpdateSection: () =>
    createElement("div", { "data-testid": "section-updates" }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  navigate.mockReset();
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
  vi.unstubAllGlobals();
});

function rosterMember(): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: "owner",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

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

function mountRoute(path = "/settings"): HTMLElement {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["roster", WS], [rosterMember()]);
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
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(SettingsRoute)
      )
    )
  );
  act(() => mountedRoot?.render(tree));
  return host;
}

describe("SettingsRoute 전면 레이아웃", () => {
  it("앱 사이드바 토글과 닫기 대신 돌아가기를 그린다", () => {
    const host = mountRoute();
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="settings-back-to-app"]')?.textContent
    ).toContain("앱으로 돌아가기");
    expect(host.querySelector('[data-testid="open-sidebar-drawer"]')).toBeNull();
    expect(
      [...host.querySelectorAll("button")].some((el) => el.textContent === "닫기")
    ).toBe(false);
  });

  it("개인 그룹 최상단이 프로필이고 기존 섹션이 모두 있다", () => {
    const host = mountRoute();
    const nav = host.querySelector('[data-testid="settings-nav"]');
    expect(nav?.textContent).toContain("개인");
    expect(nav?.textContent).toContain("워크스페이스");
    expect(nav?.textContent).toContain("연결");
    const buttons = [
      ...host.querySelectorAll('[data-testid^="settings-nav-"]'),
    ].map((el) => el.getAttribute("data-testid"));
    expect(buttons[0]).toBe("settings-nav-profile");
    expect(buttons).toEqual(
      expect.arrayContaining([
        "settings-nav-account",
        "settings-nav-devices",
        "settings-nav-appearance",
        "settings-nav-link-previews",
        "settings-nav-notifications",
        "settings-nav-ai",
        "settings-nav-agents",
        "settings-nav-workspace",
        "settings-nav-plugins",
        "settings-nav-usage",
        "settings-nav-webhooks",
        "settings-nav-members",
        "settings-nav-events",
      ])
    );
  });

  it("진입 시 현재 섹션 버튼으로 포커스가 간다", () => {
    const root = mountRoute("/settings");
    expect(document.activeElement).toBe(
      root.querySelector('[data-testid="settings-nav-profile"]')
    );
    const account = mountRoute("/settings?section=account");
    expect(document.activeElement).toBe(
      account.querySelector('[data-testid="settings-nav-account"]')
    );
  });

  it("기본 진입은 프로필이고 딥링크와 돌아가기가 유지된다", () => {
    const root = mountRoute("/settings");
    expect(
      root.querySelector('[data-testid="settings-nav-profile"]')?.getAttribute(
        "aria-current"
      )
    ).toBe("page");
    expect(root.querySelector("h2")?.textContent).toBe("프로필");
    const back = root.querySelector(
      '[data-testid="settings-back-to-app"]'
    ) as HTMLButtonElement;
    // 앱 안에서 쌓인 항목 위(라우터 idx ≥ 1)면 한 칸 뒤로.
    window.history.pushState({ idx: 1 }, "", window.location.href);
    act(() => back.click());
    expect(navigate).toHaveBeenCalledWith(-1);
    // 설정이 앱의 첫 항목(idx 0: 딥링크·온보딩 뒤)이면 앱 밖이 아니라 홈으로 (#2938 ③).
    navigate.mockClear();
    window.history.replaceState({ idx: 0 }, "", window.location.href);
    act(() => back.click());
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(navigate).not.toHaveBeenCalledWith(-1);

    const account = mountRoute("/settings?section=account");
    expect(
      account
        .querySelector('[data-testid="settings-nav-account"]')
        ?.getAttribute("aria-current")
    ).toBe("page");
    expect(account.querySelector('[data-testid="logout"]')).not.toBeNull();

    const members = mountRoute("/settings?section=members");
    expect(members.querySelector('[data-testid="section-members"]')).not.toBeNull();
  });

  it("AI 연결 구획 위에는 「AI 허브로 옮겼어요」 링크가 서고, 그 밖의 구획에는 없다 (AIH-3)", () => {
    const host = mountRoute("/settings?section=profile");
    expect(host.querySelector('[data-testid="ai-hub-moved-link"]')).toBeNull();
    act(() => {
      (host.querySelector('[data-testid="settings-nav-ai"]') as HTMLButtonElement).click();
    });
    const line = host.querySelector('[data-testid="ai-hub-moved-link"]');
    expect(line?.textContent).toContain("AI 허브로 옮겼어요");
    expect(line?.querySelector("a")?.getAttribute("href")).toContain("/ai/accounts");
    act(() => {
      (host.querySelector('[data-testid="settings-nav-account"]') as HTMLButtonElement).click();
    });
    expect(host.querySelector('[data-testid="ai-hub-moved-link"]')).toBeNull();
  });

  it("사이드바에서 기존 섹션에 모두 도달한다", () => {
    const host = mountRoute("/settings?section=profile");
    const clicks: Array<[string, string]> = [
      ["settings-nav-account", "logout"],
      ["settings-nav-devices", "device-link-card"],
      ["settings-nav-appearance", "section-appearance"],
      ["settings-nav-link-previews", "section-link-previews"],
      ["settings-nav-notifications", "section-notifications"],
      ["settings-nav-workspace", "section-workspace"],
      ["settings-nav-members", "section-members"],
      ["settings-nav-ai", "section-ai"],
      ["settings-nav-usage", "section-usage"],
    ];
    for (const [navId, panelId] of clicks) {
      act(() => {
        (host.querySelector(`[data-testid="${navId}"]`) as HTMLButtonElement).click();
      });
      expect(host.querySelector(`[data-testid="${panelId}"]`)).not.toBeNull();
    }
  });

  it("외부 연결로 옮긴 네 구획은 눌러도 설정에 머물지 않고 그 줄 상세로 간다 (AIH-8)", () => {
    const host = mountRoute("/settings?section=profile");
    const expected: Array<[string, string]> = [
      ["settings-nav-agents", "/ai/external/agents"],
      ["settings-nav-plugins", "/ai/external/apps"],
      ["settings-nav-webhooks", "/ai/external/incoming"],
      ["settings-nav-events", "/ai/external/outgoing"],
    ];
    for (const [navId, path] of expected) {
      navigate.mockClear();
      act(() => {
        (host.querySelector(`[data-testid="${navId}"]`) as HTMLButtonElement).click();
      });
      expect(navigate).toHaveBeenCalledWith(path);
    }
  });

  it.each([
    ["agents", "/ai/external/agents"],
    ["plugins", "/ai/external/apps"],
    ["webhooks", "/ai/external/incoming"],
    ["events", "/ai/external/outgoing"],
  ])("옛 딥링크 ?section=%s 는 %s 로 바꿔 보낸다 (AIH-8)", (section, target) => {
    const client = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedRoot = createRoot(host);
    act(() =>
      mountedRoot?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: sessionValue() },
            createElement(
              MemoryRouter,
              { initialEntries: [`/settings?section=${section}`] },
              createElement(
                Routes,
                null,
                createElement(Route, { path: "/settings", element: createElement(SettingsRoute) }),
                createElement(Route, { path: "*", element: createElement(LocationProbe) })
              )
            )
          )
        )
      )
    );
    expect(host.querySelector('[data-testid="settings-route"]')).toBeNull();
    expect(host.querySelector('[data-testid="location-probe"]')?.textContent).toBe(target);
  });

  it("옮기지 않은 ?section=ai 는 리다이렉트하지 않는다 (AIH-8)", () => {
    const host = mountRoute("/settings?section=ai");
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
  });
});

function LocationProbe() {
  return createElement("span", { "data-testid": "location-probe" }, useLocation().pathname);
}
