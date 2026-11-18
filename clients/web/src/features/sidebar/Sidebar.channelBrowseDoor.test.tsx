// @vitest-environment jsdom

// 사이드바 「채널」 머리의 + (ADR-0224 화면 ① · D8, #5842): 정식 멤버 모두에게 서고, 만들 수 있는 사람에게는 「채널 둘러보기」
// 「새 채널 만들기」 두 줄의 메뉴, 일반 멤버는 누르면 바로 둘러보기가 열린다. 게스트에게는 서지 않는다(서버도 403).
// 지키는 것: 게스트에게 문이 새는 뒷걸음(역할 판정을 `canCreateChannel` 처럼 「모르면 허락」으로 쓰기 등)과, 일반 멤버의 + 가
// 만들기(403 으로 끝나는 길)를 여는 뒷걸음.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { Sidebar } from "./Sidebar";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_ENGINE = "00000000-0000-7000-8000-000000000201";
const CH_GENERAL = "00000000-0000-7000-8000-000000000202";

vi.mock("@/features/workspace/useAddWorkspace", () => ({
  useOpenAddWorkspace: () => () => undefined,
}));

const doors = vi.hoisted(() => ({ create: vi.fn(), browse: vi.fn() }));
vi.mock("@/features/channels/useCreateChannel", () => ({
  useOpenCreateChannel: () => doors.create,
  useCreateChannelOpen: () => false,
}));
// 둘러보기 창의 동사는 셸이 내린다. 이 시험은 셸 없이 그리므로 동사만 붙잡아 무엇이 열렸는지 본다.
vi.mock("@/features/channels/useChannelBrowse", () => ({
  useOpenChannelBrowse: () => doors.browse,
  useChannelBrowseOpen: () => false,
}));

vi.mock("@/features/directory/useNewDm", () => ({
  useOpenNewDm: () => () => undefined,
  useNewDmOpen: () => false,
}));

vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => false,
}));

vi.mock("./ProfileCard", () => ({
  ProfileCard: ({ compact, workspaceName }: { compact?: boolean; workspaceName?: string }) =>
    createElement("span", {
      "data-testid": "profile-card",
      "data-compact": compact ? "true" : "false",
      "data-workspace-name": workspaceName ?? "",
    }),
}));

// 레일은 footer 슬롯만 그린다: 접힘에서 아바타가 레일 footer에 서는지 본다.
vi.mock("./WorkspaceRail", () => ({
  WorkspaceRail: ({ footer }: { footer?: unknown }) =>
    createElement("div", { "data-testid": "workspace-rail" }, footer as never),
}));

vi.mock("@/app/ShortcutHelpDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/ShortcutHelpDialog")>()),
  ShortcutHelpDialog: () =>
    createElement("button", { type: "button", "data-testid": "shortcut-help-trigger" }),
}));

vi.mock("@/features/drafts/DraftsNavItem", () => ({
  DraftsNavItem: () => null,
}));

const engine: Channel = {
  id: CH_ENGINE,
  workspaceId: WS,
  kind: "public",
  name: "엔진",
  muted: false,
};
const general: Channel = {
  id: CH_GENERAL,
  workspaceId: WS,
  kind: "public",
  name: "일반",
  muted: false,
};

const self: RosterMember = {
  id: MEMBER_ID,
  workspaceId: WS,
  kind: "human",
  status: "active",
  displayName: "김도현",
  handle: "dohyeon",
  role: "owner" as RosterMember["role"],
  channelCount: 2,
  channelIds: [CH_ENGINE, CH_GENERAL],
  capabilities: [],
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

const channelsQuery = {
  isLoading: false,
  isPending: false,
  error: null as Error | null,
  refetch: () => undefined,
  groups: { channels: [engine, general], dms: [] as Channel[] },
  data: [engine, general] as Channel[],
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsQuery,
    useDirectory: () => ({
      directory: makeDirectory([self]),
      isPending: false,
      isLoading: false,
    }),
    useReadStates: () => ({
      byChannel: new Map(),
      isPending: false,
      error: null,
    }),
  };
});

vi.mock("@momo/core/features/sidebar/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/sidebar/api")>();
  return {
    ...actual,
    fetchSidebarPrefs: async () => emptySidebarPrefs(),
    putSidebarPrefs: async (_ws: string, prefs: unknown) => prefs,
  };
});

// 멈춤 줄(#3923)이 읽는 알림 규칙. 기본은 멈춤 없음이고, 시험이 켠다.
const notificationRules = vi.hoisted(() => ({
  current: { dnd: false, mentionOverridesMute: false } as {
    dnd: boolean;
    mentionOverridesMute: boolean;
    dndUntilMs?: number;
  },
}));
vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: async () => ({ ...notificationRules.current }),
  };
});

vi.mock("@momo/core/features/settings/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/api")>();
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

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: MEMBER_ID, workspaceId: WS, kind: "human", displayName: "김도현", handle: "dohyeon" },
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
  const tree: ReactElement = createElement(
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
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  return host;
}

/** 머리 위에 포인터를 올려 액션 묶음을 세운다(포인터 rest 에서는 액션이 마운트되지 않는다). */
function hoverChannelsHeader(host: HTMLElement) {
  const header = host.querySelector('[data-testid="sidebar-section-channels-header"]');
  act(() => {
    header?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  doors.create.mockReset();
  doors.browse.mockReset();
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
  self.role = "owner";
  vi.unstubAllGlobals();
});

describe("사이드바 「채널」 머리의 + (채널 둘러보기 문)", () => {
  it("게스트에게는 + 가 서지 않는다", async () => {
    self.role = "guest";
    const host = await mount();
    hoverChannelsHeader(host);
    expect(host.querySelector('[data-testid="sidebar-section-channels-header"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="new-channel"]')).toBeNull();
  });

  it("일반 멤버의 + 는 메뉴 없이 바로 둘러보기 창을 연다(만들기가 아니다)", async () => {
    self.role = "member";
    const host = await mount();
    hoverChannelsHeader(host);
    const plus = host.querySelector<HTMLButtonElement>('[data-testid="new-channel"]');
    expect(plus).not.toBeNull();
    expect(plus?.getAttribute("aria-haspopup")).toBeNull();
    act(() => plus?.click());
    expect(doors.browse).toHaveBeenCalledTimes(1);
    expect(doors.browse.mock.calls[0][0]).toEqual({ opener: plus });
    expect(doors.create).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("%s 의 + 는 둘러보기 · 만들기 두 줄의 메뉴다", async (role) => {
    self.role = role;
    const host = await mount();
    hoverChannelsHeader(host);
    const plus = host.querySelector<HTMLButtonElement>('[data-testid="new-channel"]');
    expect(plus?.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => {
      plus?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    const items = Array.from(document.querySelectorAll('[data-testid="new-channel-menu"] [role="menuitem"]')).map(
      (item) => item.getAttribute("data-testid")
    );
    expect(items).toEqual(["new-channel-browse", "new-channel-create"]);
    // 메뉴가 열린 동안 + 는 붙들려 있다(Esc 로 창을 닫을 때 돌아올 자리).
    expect(host.querySelector('[data-testid="new-channel"]')).toBe(plus);
    await act(async () => {
      document.querySelector<HTMLElement>('[data-testid="new-channel-browse"]')?.click();
      await new Promise((done) => requestAnimationFrame(() => done(undefined)));
    });
    expect(doors.browse).toHaveBeenCalledWith({ opener: plus });
    expect(doors.create).not.toHaveBeenCalled();
  });
});
