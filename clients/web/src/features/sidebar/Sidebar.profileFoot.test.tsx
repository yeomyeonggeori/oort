// @vitest-environment jsdom

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
import { resetUpdateStoreForTest, seedUpdateStateForTest } from "@/features/updates/store";
import { Sidebar } from "./Sidebar";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_ENGINE = "00000000-0000-7000-8000-000000000201";
const CH_GENERAL = "00000000-0000-7000-8000-000000000202";

vi.mock("@/features/workspace/useAddWorkspace", () => ({
  useOpenAddWorkspace: () => () => undefined,
}));

vi.mock("@/features/channels/useCreateChannel", () => ({
  useOpenCreateChannel: () => () => undefined,
  useCreateChannelOpen: () => false,
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
  displayName: "곽성재",
  handle: "seongjae",
  role: "owner",
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

async function mount(opts: { collapsed?: boolean; isMobile?: boolean } = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        ShellNavProvider,
        {
          value: {
            isMobile: opts.isMobile ?? false,
            drawerOpen: false,
            openDrawer: () => undefined,
            closeDrawer: () => undefined,
          },
        },
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(Sidebar, {
            onOpenQuickSwitcher: () => undefined,
            channelPaneCollapsed: opts.collapsed ?? false,
            treeHidden: false,
          })
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

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  notificationRules.current = { dnd: false, mentionOverridesMute: false };
  channelsQuery.isLoading = false;
  channelsQuery.groups = { channels: [engine, general], dms: [] };
  channelsQuery.data = [engine, general];
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

describe("사이드바 하단 프로필 (#3574)", () => {
  it("펼침: 프로필은 목록 열 끝의 한 줄이고 레일에는 서지 않는다, 도움말은 같은 줄이다", async () => {
    const host = await mount();
    const foot = await vi.waitFor(() => {
      const node = host.querySelector('[data-testid="sidebar-profile-foot"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    const card = foot.querySelector('[data-testid="profile-card"]');
    expect(card?.getAttribute("data-compact")).toBe("false");
    await vi.waitFor(() =>
      expect(
        foot.querySelector('[data-testid="profile-card"]')?.getAttribute("data-workspace-name")
      ).toBe("새벽")
    );
    expect(foot.querySelector('[data-testid="shortcut-help-trigger"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="workspace-rail"] [data-testid="profile-card"]')
    ).toBeNull();
    expect(host.querySelectorAll('[data-testid="profile-card"]').length).toBe(1);
    // 띠·구분선 없음: 이 줄에 테두리·배경 클래스가 없다.
    expect(foot.className).not.toMatch(/\b(border|bg-|divide)/);
  });

  it("접힘(⌘B): 프로필은 레일에 아바타(compact)로만 서고 목록 끝 줄에는 없다", async () => {
    const host = await mount({ collapsed: true });
    const railCard = await vi.waitFor(() => {
      const node = host.querySelector(
        '[data-testid="workspace-rail"] [data-testid="profile-card"]'
      );
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(railCard.getAttribute("data-compact")).toBe("true");
    expect(
      host
        .querySelector('[data-testid="sidebar-profile-foot"]')
        ?.querySelector('[data-testid="profile-card"]')
    ).toBeNull();
    expect(host.querySelectorAll('[data-testid="profile-card"]').length).toBe(1);
  });

  it("폰 서랍: 접힘 상태여도 프로필은 목록 끝 줄이다(레일 아바타 아님)", async () => {
    const host = await mount({ collapsed: true, isMobile: true });
    const foot = await vi.waitFor(() => {
      const node = host.querySelector('[data-testid="sidebar-profile-foot"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(
      foot.querySelector('[data-testid="profile-card"]')?.getAttribute("data-compact")
    ).toBe("false");
  });
  it("업데이트 알약: 펼침의 프로필 줄에는 서고, 접힘(⌘B)에서는 마운트되지 않는다 (#3904)", async () => {
    const update = {
      version: "0.1.28",
      currentVersion: "0.1.27",
      notes: null,
      publishedAt: null,
    };
    resetUpdateStoreForTest();
    seedUpdateStateForTest({ kind: "available", update });
    const expanded = await mount();
    const foot = await vi.waitFor(() => {
      const node = expanded.querySelector('[data-testid="sidebar-profile-foot"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    expect(foot.querySelector('[data-testid="update-pill"]')).not.toBeNull();
    // 알약은 프로필 카드와 도움말 사이, 같은 줄이다.
    const order = Array.from(foot.querySelectorAll("[data-testid]")).map((n) =>
      n.getAttribute("data-testid")
    );
    expect(order.indexOf("update-pill")).toBeGreaterThan(order.indexOf("profile-card"));
    expect(order.indexOf("update-pill")).toBeLessThan(order.indexOf("shortcut-help-trigger"));
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    mountedHost = null;

    const collapsed = await mount({ collapsed: true });
    expect(collapsed.querySelector('[data-testid="update-pill"]')).toBeNull();
    resetUpdateStoreForTest();
  });

  it("멈춤 줄(#3923): 프로필 줄 **아래**에 같은 안전 영역 묶음으로 서고, 프로필 줄 안에는 들어가지 않는다", async () => {
    notificationRules.current = { dnd: true, mentionOverridesMute: false, dndUntilMs: 1_800_000_900_000 };
    const host = await mount();
    const banner = await vi.waitFor(() => {
      const node = host.querySelector('[data-testid="pause-banner"]');
      expect(node).not.toBeNull();
      return node as HTMLElement;
    });
    const foot = host.querySelector('[data-testid="sidebar-profile-foot"]') as HTMLElement;
    // 프로필 카드는 전체가 버튼이라 그 안에 단추를 둘 수 없다: 줄은 카드의 형제이고 프로필 줄의 **다음** 형제다.
    expect(foot.contains(banner)).toBe(false);
    expect(foot.nextElementSibling).toBe(banner);
    // 안전 영역(홈 인디케이터)은 둘이 함께 진다.
    expect(foot.parentElement?.className).toMatch(/\bsafe-area-bottom\b/);
    expect(foot.parentElement?.contains(banner)).toBe(true);
    // 프로필 줄 자체는 여전히 띠·구분선 없이 한 줄이다.
    expect(foot.className).not.toMatch(/\b(border|bg-|divide)/);
    expect(foot.className).not.toMatch(/safe-area-bottom/);
  });

  it("멈춤 줄(#3923): 멈춤이 없으면 줄도 자리도 없다", async () => {
    const host = await mount();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="sidebar-profile-foot"]')).not.toBeNull()
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector('[data-testid="pause-banner"]')).toBeNull();
  });

  it("멈춤 줄(#3923): 접힘(⌘B)에서는 서지 않는다 — 그 자리에는 레일의 아바타만 있다", async () => {
    notificationRules.current = { dnd: true, mentionOverridesMute: false };
    const host = await mount({ collapsed: true });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="workspace-rail"]')).not.toBeNull()
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector('[data-testid="pause-banner"]')).toBeNull();
  });
});

// #3662: 새 DM 모달의 문은 셸(NewDmProvider)이 내리는 동사다. 이 시험은 셸 없이 그리므로
// 문만 막아 둔다(모달 자체는 NewDmDialog.test가 잰다).
vi.mock("@/features/directory/useNewDm", () => ({
  useOpenNewDm: () => () => undefined,
  useNewDmOpen: () => false,
}));
