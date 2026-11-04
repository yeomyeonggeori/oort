// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel, type RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { Sidebar } from "./Sidebar";

// =============================================================================
// #5242: 사이드바 채널 목록의 불러오기 실패. 옛 「채널을 불러오지 못했습니다.」 배너는 이제 S-C의 원인 상자다.
//   - 받아 둔 채널이 **없으면** 제목 + 이유 한 줄 + 다시 시도 상자, **있으면** 목록은 그대로 두고 위에 한 줄만.
//   - 이유는 원인을 따라간다(오프라인 / 서버에 닿지 못함 / 그 밖). 상태 코드·서버 원문은 없다.
// 하네스는 `Sidebar.skel.test.tsx`와 같다(목록 질의만 가짜).
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_ENGINE = "00000000-0000-7000-8000-000000000201";

vi.mock("@/features/workspace/useAddWorkspace", () => ({
  useOpenAddWorkspace: () => () => undefined,
}));
vi.mock("@/features/channels/useCreateChannel", () => ({
  useOpenCreateChannel: () => () => undefined,
  useCreateChannelOpen: () => false,
}));
vi.mock("@/features/directory/useNewDm", () => ({
  useOpenNewDm: () => () => undefined,
  useNewDmOpen: () => false,
}));
vi.mock("@/features/emoji/useHoverNone", () => ({ useHoverNone: () => false }));
vi.mock("./ProfileCard", () => ({ ProfileCard: () => null }));
vi.mock("./WorkspaceRail", () => ({ WorkspaceRail: () => null }));
vi.mock("@/app/ShortcutHelpDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/ShortcutHelpDialog")>()),
  ShortcutHelpDialog: () => null,
}));
vi.mock("@/features/drafts/DraftsNavItem", () => ({ DraftsNavItem: () => null }));

const engine: Channel = { id: CH_ENGINE, workspaceId: WS, kind: "public", name: "엔진", muted: false };
const self: RosterMember = {
  id: MEMBER_ID,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
  channelCount: 1,
  channelIds: [CH_ENGINE],
  capabilities: [],
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

const refetch = vi.fn();
const channelsQuery = {
  isLoading: false,
  isPending: false,
  error: null as Error | null,
  refetch,
  groups: { channels: [] as Channel[], dms: [] as Channel[] },
  data: [] as Channel[],
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsQuery,
    useDirectory: () => ({ directory: makeDirectory([self]), isPending: false, isLoading: false }),
    useReadStates: () => ({ byChannel: new Map(), isPending: false, error: null }),
  };
});
vi.mock("@momo/core/features/sidebar/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/sidebar/api")>();
  return {
    ...actual,
    fetchSidebarPrefs: async () => emptySidebarPrefs(),
    putSidebarPrefs: async (_ws: string, prefs: unknown) => prefs,
  };
});
vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/settings/api")>();
  return {
    ...actual,
    fetchWorkspace: async () => ({
      id: WS,
      slug: "dawn",
      name: "새벽",
      updatedAtMs: 1_800_000_000_000,
      roleLabels: {},
      welcomeAgentMemberId: null,
      welcomePrompt: "",
    }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let ko: AppLocale;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: MEMBER_ID, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: ReactElement = createElement(LocaleProvider, {
    locale: ko,
    children: createElement(
      QueryClientProvider,
      { client },
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(
          ShellNavProvider,
          { value: { isMobile: false, drawerOpen: false, openDrawer: () => undefined, closeDrawer: () => undefined } },
          createElement(
            MemoryRouter,
            { initialEntries: ["/"] },
            createElement(Sidebar, { onOpenQuickSwitcher: () => undefined, channelPaneCollapsed: false, treeHidden: false })
          )
        )
      )
    ),
  });
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

function deviceOnline(value: boolean): void {
  vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(value);
}

beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  refetch.mockReset();
  channelsQuery.isLoading = false;
  channelsQuery.error = null;
  channelsQuery.groups = { channels: [], dms: [] };
  channelsQuery.data = [];
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
  vi.restoreAllMocks();
});

describe("Sidebar: 채널 목록 불러오기 실패", () => {
  // 지키는 것: 받아 둔 채널이 없으면 상자(제목 + 이유 + 다시 시도), 이유는 원인을 따라간다.
  it("받아 둔 채널이 없으면 상자가 서고, 이유가 원인을 따라가며, 다시 시도가 목록을 다시 읽는다", async () => {
    const cases: [Error, boolean, string, string][] = [
      [new NetworkError("unreachable", 15_000), false, "deviceOffline", "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
      [new NetworkError("unreachable", 15_000), true, "serverUnreachable", "서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요."],
      [new ApiError(500, "boom", "internal"), true, "", "문제가 생겼어요. 다시 시도해 주세요."],
    ];
    for (const [error, online, cause, reason] of cases) {
      deviceOnline(online);
      channelsQuery.error = error;
      refetch.mockClear();
      const host = await mount();
      const box = host.querySelector<HTMLElement>('[data-testid="channels-error"]');
      expect(box, reason).not.toBeNull();
      expect(box?.getAttribute("role")).toBe("alert");
      expect(box?.getAttribute("data-cause") ?? "").toBe(cause);
      expect(box?.textContent).toContain("채널 목록을 불러오지 못했어요");
      expect(box?.querySelector('[data-testid="load-failure-reason"]')?.textContent).toBe(reason);
      expect(box?.textContent).not.toMatch(/\d{3}/);
      expect(host.textContent).not.toContain("채널을 불러오지 못했습니다");
      expect(host.querySelector('[data-testid="channels-error-line"]')).toBeNull();
      await act(async () => {
        box?.querySelector("button")?.click();
      });
      expect(refetch).toHaveBeenCalledTimes(1);
      act(() => mountedRoot?.unmount());
      mountedHost?.remove();
      mountedRoot = null;
      mountedHost = null;
    }
  });

  // 지키는 것: 받아 둔 채널이 있으면 상자로 덮지 않는다. 목록은 그대로 두고 위에 한 줄만 선다.
  it("받아 둔 채널이 있으면 상자 없이 목록은 그대로 두고 위에 한 줄만 선다", async () => {
    deviceOnline(true);
    channelsQuery.error = new NetworkError("unreachable", 15_000);
    channelsQuery.groups = { channels: [engine], dms: [] };
    channelsQuery.data = [engine];
    const host = await mount();
    expect(host.querySelector('[data-testid="channels-error"]')).toBeNull();
    const line = host.querySelector<HTMLElement>('[data-testid="channels-error-line"]');
    expect(line?.textContent).toContain("채널 목록을 불러오지 못했어요");
    expect(host.textContent).toContain("엔진");
    await act(async () => {
      line?.querySelector("button")?.click();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("읽기에 실패하지 않았으면 상자도 한 줄도 없다", async () => {
    channelsQuery.groups = { channels: [engine], dms: [] };
    channelsQuery.data = [engine];
    const host = await mount();
    expect(host.querySelector('[data-testid="channels-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="channels-error-line"]')).toBeNull();
    expect(host.textContent).toContain("엔진");
  });
});
