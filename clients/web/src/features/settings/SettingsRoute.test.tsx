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
// 단축키 페이지는 로컬 터미널 카드를 스스로 든다(#3615 S5a: 검색 중에는 터미널 목록을 숨기려고
// 한 컴포넌트가 둘 다 그린다). 그래서 이 한 목은 두 표지를 함께 낸다.
vi.mock("./ShortcutsSection", () => ({
  ShortcutsSection: () =>
    createElement(
      "div",
      { "data-testid": "section-shortcuts" },
      createElement("div", { "data-testid": "section-terminal" })
    ),
}));
vi.mock("./AppearanceSection", () => ({
  AppearanceSection: () =>
    createElement("div", { "data-testid": "section-appearance" }),
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

  it("개인 그룹 최상단이 프로필이고 12행이 세 그룹에 선다", () => {
    const host = mountRoute();
    const nav = host.querySelector('[data-testid="settings-nav"]');
    expect(nav?.textContent).toContain("개인");
    expect(nav?.textContent).toContain("워크스페이스");
    expect(nav?.textContent).toContain("앱·연결");
    const buttons = [
      ...host.querySelectorAll('[data-testid^="settings-nav-"]'),
    ].map((el) => el.getAttribute("data-testid"));
    // 브라우저에는 업데이트(데스크톱 전용)와 실행 호스트(서버 표면)가 없다. 기억은 서버 표면이 있다.
    expect(buttons).toEqual([
      "settings-nav-profile",
      "settings-nav-appearance",
      "settings-nav-notifications",
      "settings-nav-shortcuts",
      "settings-nav-devices",
      "settings-nav-workspace",
      "settings-nav-members",
      "settings-nav-memory",
      "settings-nav-usage",
      "settings-nav-ai",
    ]);
    // 닫힌 네 행(앱·외부 에이전트 연결·채널로 들어오는 주소·밖으로 보내는 알림)은 목차에 없다.
    for (const gone of ["agents", "plugins", "webhooks", "events", "account", "terminal", "link-previews"]) {
      expect(host.querySelector(`[data-testid="settings-nav-${gone}"]`), gone).toBeNull();
    }
  });

  it("목록 행은 앱 사이드바와 같은 sidebar-row이고 아이콘이 있으며 선택 행만 selected다", () => {
    const host = mountRoute();
    const profile = host.querySelector('[data-testid="settings-nav-profile"]') as HTMLElement;
    const appearance = host.querySelector('[data-testid="settings-nav-appearance"]') as HTMLElement;
    for (const row of [profile, appearance]) {
      expect(row.classList.contains("sidebar-row")).toBe(true);
      expect(row.querySelector("[data-row-icon] svg")).not.toBeNull();
    }
    expect(profile.classList.contains("sidebar-row-selected")).toBe(true);
    expect(appearance.classList.contains("sidebar-row-selected")).toBe(false);
    // 선·구분 상자 대신 그룹 라벨뿐이다: 목록 안에 <hr>·separator가 없다.
    const nav = host.querySelector('[data-testid="settings-nav"]')!;
    expect(nav.querySelector('hr, [role="separator"]')).toBeNull();
  });

  it("페이지 머리는 보이는 h1 하나이고 범위 칩을 단다", () => {
    const host = mountRoute();
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(host.querySelector("h1")?.textContent).toBe("프로필");
    expect(host.querySelector('[data-testid="settings-scope-chip"]')?.textContent).toContain(
      "이 워크스페이스에서 보여요"
    );
    act(() => {
      (host.querySelector('[data-testid="settings-nav-appearance"]') as HTMLButtonElement).click();
    });
    expect(host.querySelector("h1")?.textContent).toBe("모양");
    expect(host.querySelector('[data-testid="settings-scope-chip"]')?.textContent).toContain(
      "이 기기에만 저장돼요"
    );
  });

  it("진입 시 현재 섹션 버튼으로 포커스가 간다", () => {
    const root = mountRoute("/settings");
    expect(document.activeElement).toBe(
      root.querySelector('[data-testid="settings-nav-profile"]')
    );
    // 합친 옛 구획(account)은 그 구획이 들어간 프로필 행에 닿는다.
    const account = mountRoute("/settings?section=account");
    expect(document.activeElement).toBe(
      account.querySelector('[data-testid="settings-nav-profile"]')
    );
    const devices = mountRoute("/settings?section=devices");
    expect(document.activeElement).toBe(
      devices.querySelector('[data-testid="settings-nav-devices"]')
    );
  });

  it("기본 진입은 프로필이고 딥링크와 돌아가기가 유지된다", () => {
    const root = mountRoute("/settings");
    expect(
      root.querySelector('[data-testid="settings-nav-profile"]')?.getAttribute(
        "aria-current"
      )
    ).toBe("page");
    expect(root.querySelector("h1")?.textContent).toBe("프로필");
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
        .querySelector('[data-testid="settings-nav-profile"]')
        ?.getAttribute("aria-current")
    ).toBe("page");
    expect(account.querySelector('[data-testid="logout"]')).not.toBeNull();
    // 별칭은 프로필 한 페이지를 연다: 옛 「계정」 페이지는 따로 없다.
    expect(account.querySelector("h1")?.textContent).toBe("프로필");
    expect(account.querySelector('[data-testid="profile-account-card"]')).not.toBeNull();
    expect(account.querySelector('[data-testid="workspace-leave"]')).not.toBeNull();
    expect(account.querySelectorAll('[data-testid="logout"]').length).toBe(1);

    const members = mountRoute("/settings?section=members");
    expect(members.querySelector('[data-testid="section-members"]')).not.toBeNull();
  });

  it("AI 허브 행은 설정 페이지를 바꾸지 않고 허브로 간다", () => {
    const host = mountRoute("/settings?section=profile");
    const row = host.querySelector('[data-testid="settings-nav-ai"]') as HTMLButtonElement;
    expect(row.querySelector("svg")).not.toBeNull();
    act(() => row.click());
    expect(navigate).toHaveBeenCalledWith("/ai/accounts");
    expect(host.querySelector("h1")?.textContent).toBe("프로필");
    expect(row.getAttribute("aria-current")).toBeNull();
    expect(host.querySelector('[data-testid="ai-hub-moved-link"]')).toBeNull();
  });

  it("옛 ?section=ai 는 리다이렉트하지 않고 옛 AI 연결 화면과 「AI 화면으로 옮겼어요」 줄을 연다", () => {
    const host = mountRoute("/settings?section=ai");
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="section-ai"]')).not.toBeNull();
    const line = host.querySelector('[data-testid="ai-hub-moved-link"]');
    expect(line?.textContent).toContain("AI 화면으로 옮겼어요");
    expect(line?.querySelector("a")?.getAttribute("href")).toContain("/ai/accounts");
    expect(host.querySelector('[data-testid="settings-nav-ai"]')?.getAttribute("aria-current")).toBe("page");
    // 곁판이 있는 화면이라 읽는 폭 제한과 카드 껍질을 쓰지 않는다.
    expect(host.querySelector('[data-testid="settings-legacy-card"]')).toBeNull();
    expect(host.querySelector(".settings-page")?.hasAttribute("data-wide")).toBe(true);
  });

  it("사이드바에서 기존 섹션에 모두 도달한다 (합친 페이지는 옛 본문을 이어 붙인다)", () => {
    const host = mountRoute("/settings?section=profile");
    expect(host.querySelector('[data-testid="logout"]')).not.toBeNull();
    const clicks: Array<[string, string[]]> = [
      ["settings-nav-devices", ["device-link-card"]],
      ["settings-nav-appearance", ["section-appearance"]],
      ["settings-nav-shortcuts", ["section-shortcuts", "section-terminal"]],
      ["settings-nav-notifications", ["section-notifications"]],
      ["settings-nav-workspace", ["section-workspace"]],
      ["settings-nav-members", ["section-members"]],
      ["settings-nav-usage", ["section-usage"]],
    ];
    for (const [navId, panelIds] of clicks) {
      act(() => {
        (host.querySelector(`[data-testid="${navId}"]`) as HTMLButtonElement).click();
      });
      for (const panelId of panelIds) {
        expect(host.querySelector(`[data-testid="${panelId}"]`), `${navId} → ${panelId}`).not.toBeNull();
      }
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

  it("합친 옛 구획 딥링크는 설정에 머물며 합쳐진 페이지를 연다", () => {
    for (const [legacy, nav] of [
      ["account", "settings-nav-profile"],
      ["link-previews", "settings-nav-appearance"],
      ["terminal", "settings-nav-shortcuts"],
    ]) {
      const host = mountRoute(`/settings?section=${legacy}`);
      expect(host.querySelector('[data-testid="settings-route"]'), legacy).not.toBeNull();
      expect(host.querySelector(`[data-testid="${nav}"]`)?.getAttribute("aria-current"), legacy).toBe("page");
    }
  });

  it("키보드: 목록에서 ↑↓가 행을 옮기고 끝에서 돌아온다", () => {
    const host = mountRoute("/settings?section=profile");
    const nav = host.querySelector('[data-testid="settings-nav"]') as HTMLElement;
    const profile = host.querySelector('[data-testid="settings-nav-profile"]') as HTMLButtonElement;
    profile.focus();
    act(() => {
      profile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="settings-nav-appearance"]'));
    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })
      );
    });
    expect(document.activeElement).toBe(profile);
    act(() => {
      profile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="settings-nav-ai"]'));
    // 가로 한 줄(폰)에서는 ←→, 양 끝은 Home/End.
    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true })
      );
    });
    expect(document.activeElement).toBe(profile);
    act(() => {
      profile.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="settings-nav-appearance"]'));
    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true })
      );
    });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="settings-nav-ai"]'));
    expect(nav).not.toBeNull();
  });
});

function LocationProbe() {
  return createElement("span", { "data-testid": "location-probe" }, useLocation().pathname);
}
