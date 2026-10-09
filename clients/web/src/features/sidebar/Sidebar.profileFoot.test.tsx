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
});
