// @vitest-environment jsdom

import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, RosterMember, WorkHost } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { WORK_SURFACE_IDS } from "@momo/core/features/capabilities/serverSurfaces";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { SettingsRoute } from "@/features/settings/SettingsRoute";
import { ChatShell } from "@/features/chat/ChatShell";
import {
  dockSnapshot,
  resetDockStateForTest,
} from "@/features/workbench/local/dockState";

// =============================================================================
// #2166 work-surface hide: count real entry points in the rendered tree.
//
// The flag under test is the existing SURFACES `provided` bit, reached through
// `isSurfaceProvided`. A constant-table assertion would stay green if a row
// were added and never wired; counting sidebar / ⌘K / settings nodes is the
// thing that can go red.
//
// #2753: the channel header terminal dock (`open-terminal-dock`) is a work
// entry point too. It observes host-side work sessions, so on a server with no
// host it was a dead end that ignored this flag. ChatShell is mounted next to
// the sidebar so the header button is counted with the rest.
// =============================================================================

// ChatShell's heavy children are stubbed the same way ChatShell.skel.test.tsx
// does: this file counts the header button, not the timeline or the dock body.
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function MockVirtuoso(
    props: {
      data: { kind: string; key: string }[];
      itemContent: (
        index: number,
        item: { kind: string; key: string }
      ) => ReactElement;
    },
    ref: Ref<{ scrollToIndex: (opts: unknown) => void }>
  ) {
    useImperativeHandle(ref, () => ({
      scrollToIndex: () => undefined,
    }));
    return createElement(
      "div",
      { "data-testid": "timeline-virtuoso" },
      props.data.map((item, index) =>
        createElement("div", { key: item.key }, props.itemContent(index, item))
      )
    );
  }),
}));

vi.mock("@/features/timeline/useTimeline", async () => {
  const { idleTimelineMock } = await import("@/features/timeline/idleTimelineMock");
  return { useTimeline: () => idleTimelineMock() };
});

vi.mock("@/features/chat/useTyping", () => ({
  useTypingReceive: () => undefined,
}));

vi.mock("@/features/directory/memberProfileContext", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/directory/memberProfileContext")
  >()),
  useOpenMemberProfile: () => () => undefined,
}));

vi.mock("@/features/channels/useAddChannelMember", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/channels/useAddChannelMember")
  >()),
  useOpenAddChannelMember: () => () => undefined,
}));

vi.mock("@/features/agents/workLogStore", () => ({
  useWorkPanelTarget: () => null,
}));

vi.mock("@/app/SidebarDrawerToggle", () => ({
  SidebarDrawerToggle: () => null,
}));

vi.mock("@/features/chat/Composer", () => ({
  Composer: () => null,
}));

vi.mock("@/features/hostedAgents/FirstMentionOnboarding", () => ({
  FirstMentionOnboarding: () => null,
}));

vi.mock("@/features/huddles/HuddleHeaderControl", () => ({
  HuddleHeaderState: ({
    children,
  }: {
    children: (huddle: null) => ReactElement;
  }) => children(null),
  HuddleHeaderControl: () => null,
  HuddleHeaderBanner: () => null,
}));

vi.mock("@/features/timeline/PinListMenu", () => ({
  PinListMenu: () => null,
}));

vi.mock("@/features/chat/ChannelHeaderMenu", () => ({
  ChannelHeaderMenu: () => null,
}));

vi.mock("@/features/timeline/LongPressHint", () => ({
  LongPressHint: () => null,
}));

vi.mock("@/features/work/WorkPanel", () => ({
  WorkPanel: () => null,
}));

vi.mock("@/features/work/TerminalDock", () => ({
  TerminalDock: () => createElement("div", { "data-testid": "observer-dock-stub" }),
}));

// #2774: 데스크탑 셸이면 헤더 터미널 버튼이 로컬 도크를 연다.
const shell = { desktop: false };
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isDesktop: () => shell.desktop,
}));

vi.mock("@/features/timeline/ThreadPanel", () => ({
  ThreadPanel: () => null,
}));

const workFlag = { provided: false };

// #2780: 정적 표 절반은 위 `workFlag`가, 런타임 절반은 이 호스트 목록이 정한다.
// 목록은 진짜 `useWorkHosts` 경로로 흐른다: 화면이 부르는 GET만 이 자리에서 바꾼다.
const hostList: { hosts: WorkHost[] } = { hosts: [] };

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchWorkHosts: async () => hostList.hosts,
    fetchWorkSessions: async () => [],
  };
});

vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>();
  const workIds = new Set<string>(actual.WORK_SURFACE_IDS);
  return {
    ...actual,
    isSurfaceProvided: (id: string) =>
      workIds.has(id)
        ? workFlag.provided
        : actual.isSurfaceProvided(
            id as import("@momo/core/features/capabilities/serverSurfaces").SurfaceId
          ),
  };
});

vi.mock("@/features/workspace/useAddWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useAddWorkspace")>();
  return {
    ...actual,
    useOpenAddWorkspace: () => () => undefined,
  };
});

vi.mock("@/features/channels/useCreateChannel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/channels/useCreateChannel")>();
  return {
    ...actual,
    useOpenCreateChannel: () => () => undefined,
    useCreateChannelOpen: () => false,
  };
});

vi.mock("@/features/routing/useAgentProfile", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/routing/useAgentProfile")>();
  return { ...actual, useOpenAgentProfile: () => () => undefined };
});

vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => false,
}));

vi.mock("@/features/sidebar/ProfileCard", () => ({
  ProfileCard: () => null,
}));

vi.mock("@/features/sidebar/WorkspaceRail", () => ({
  WorkspaceRail: () => null,
}));

// 다이얼로그만 재운다. 같은 모듈의 `Keycaps`는 ⌘K 팔레트가 키캡 힌트를 그릴 때
// 쓰는 순수 컴포넌트라 진짜가 필요하다 (ADR-0186 D1).
vi.mock("@/app/ShortcutHelpDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/ShortcutHelpDialog")>()),
  ShortcutHelpDialog: () => null,
}));

vi.mock("@/features/drafts/DraftsNavItem", () => ({
  DraftsNavItem: () => null,
}));

vi.mock("@/features/drafts/useDraftsPanel", () => ({
  useDraftsPanel: () => ({ showNav: false }),
}));

vi.mock("@/features/settings/AiLinkSection", () => ({
  AiLinkSection: () => createElement("div", { "data-testid": "section-ai" }),
}));
vi.mock("@/features/settings/AgentCredentialsSection", () => ({
  AgentCredentialsSection: () =>
    createElement("div", { "data-testid": "section-agents" }),
}));
vi.mock("@/features/settings/WorkHostSection", () => ({
  WorkHostSection: () => createElement("div", { "data-testid": "section-code" }),
}));
vi.mock("@/features/settings/WorkspaceSection", () => ({
  WorkspaceSection: () =>
    createElement("div", { "data-testid": "section-workspace" }),
}));
vi.mock("@/features/plugins/PluginSection", () => ({
  PluginSection: () =>
    createElement("div", { "data-testid": "section-plugins" }),
}));
vi.mock("@/features/settings/UsageSection", () => ({
  UsageSection: () => createElement("div", { "data-testid": "section-usage" }),
}));
vi.mock("@/features/settings/WebhookSection", () => ({
  WebhookSection: () =>
    createElement("div", { "data-testid": "section-webhooks" }),
}));
vi.mock("@/features/settings/InviteSection", () => ({
  InviteSection: () =>
    createElement("div", { "data-testid": "section-members" }),
}));
vi.mock("@/features/settings/EventSubscriptionSection", () => ({
  EventSubscriptionSection: () =>
    createElement("div", { "data-testid": "section-events" }),
}));
vi.mock("@/features/settings/NotificationRulesSection", () => ({
  NotificationRulesSection: () =>
    createElement("div", { "data-testid": "section-notifications" }),
}));
vi.mock("@/features/settings/AppearanceSection", () => ({
  AppearanceSection: () =>
    createElement("div", { "data-testid": "section-appearance" }),
}));
vi.mock("@/features/settings/LinkPreviewSection", () => ({
  LinkPreviewSection: () =>
    createElement("div", { "data-testid": "section-link-previews" }),
}));
vi.mock("@/features/updates/UpdateSection", () => ({
  UpdateSection: () =>
    createElement("div", { "data-testid": "section-updates" }),
}));

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";

const ENTRY_TEST_IDS = [
  "nav-work-console",
  "nav-workstreams",
  "switcher-work-console",
  "switcher-workstreams",
  "settings-nav-code",
  "open-terminal-dock",
] as const;

const engine: Channel = {
  id: CH,
  workspaceId: WS,
  kind: "public",
  name: "엔진",
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
  channelCount: 1,
  channelIds: [CH],
  capabilities: [],
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

const channelsQuery = {
  isLoading: false,
  isPending: false,
  isSuccess: true,
  isError: false,
  error: null as Error | null,
  refetch: () => undefined,
  groups: { channels: [engine], dms: [] as Channel[] },
  data: [engine] as Channel[],
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
      refetch: () => undefined,
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
let mountedClient: QueryClient | null = null;

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

async function mount(): Promise<HTMLElement> {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["roster", WS], [self]);
  mountedClient = client;
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
            isMobile: false,
            drawerOpen: false,
            openDrawer: () => undefined,
            closeDrawer: () => undefined,
          },
        },
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(
            "div",
            null,
            createElement(Sidebar, {
              onOpenQuickSwitcher: () => undefined,
              channelPaneCollapsed: false,
              treeHidden: false,
            }),
            createElement(QuickSwitcher, {
              open: true,
              onOpenChange: () => undefined,
            }),
            createElement(SettingsRoute),
            createElement(ChatShell)
          )
        )
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="nav-directory"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
    // The header group renders whether or not the dock button is in it, so
    // waiting on it cannot mask a missing button.
    expect(
      host.querySelector('[data-testid="channel-header-controls"]')
    ).not.toBeNull();
  });
  return host;
}

/**
 * 호스트 목록 조회가 끝날 때까지 기다린다. 끝나기 전에 「0개」를 세면, 판정을
 * 상수 참으로 바꿔도 초록이다(아직 아무것도 모르는 첫 그림을 센 것이라서).
 */
async function hostsSettled(): Promise<void> {
  await vi.waitFor(() => {
    expect(mountedClient?.getQueryState(["work-hosts", WS])?.status).toBe(
      "success"
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function entryCounts(): Record<string, number> {
  return Object.fromEntries(
    ENTRY_TEST_IDS.map((id) => [
      id,
      document.querySelectorAll(`[data-testid="${id}"]`).length,
    ])
  );
}

function onlineHost(overrides: Partial<WorkHost> = {}): WorkHost {
  return {
    id: "00000000-0000-7000-8000-000000000301",
    workspaceId: WS,
    scope: "workspace",
    ownerMemberId: MEMBER_ID,
    type: "workd",
    displayName: "팀 맥 미니",
    capabilities: {},
    createdAtMs: 1_800_000_000_000,
    online: true,
    ...overrides,
  };
}

function countWorkEntries(root: ParentNode = document): number {
  return ENTRY_TEST_IDS.reduce(
    (sum, id) => sum + root.querySelectorAll(`[data-testid="${id}"]`).length,
    0
  );
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
});

beforeEach(() => {
  workFlag.provided = false;
  hostList.hosts = [];
  shell.desktop = false;
  resetDockStateForTest();
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
  mountedClient = null;
  vi.unstubAllGlobals();
});

describe("work 표면 진입점 (#2166)", () => {
  it("숨긴 표면 id는 workstreams · workConsole · work · ade 이다", () => {
    expect([...WORK_SURFACE_IDS]).toEqual([
      "workstreams",
      "workConsole",
      "work",
      "ade",
    ]);
  });

  it("provided:false 이면 사이드바·QuickSwitcher·설정·채널 헤더 도크 진입점이 0이다", async () => {
    workFlag.provided = false;
    const host = await mount();
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
    expect(countWorkEntries()).toBe(0);
  });

  it("provided:true 이면 같은 여섯 진입점이 복귀한다", async () => {
    workFlag.provided = true;
    const host = await mount();
    expect(host.querySelector('[data-testid="settings-route"]')).not.toBeNull();
    const counts = Object.fromEntries(
      ENTRY_TEST_IDS.map((id) => [
        id,
        document.querySelectorAll(`[data-testid="${id}"]`).length,
      ])
    );
    expect(counts).toEqual({
      "nav-work-console": 1,
      "nav-workstreams": 1,
      "switcher-work-console": 1,
      "switcher-workstreams": 1,
      "settings-nav-code": 1,
      "open-terminal-dock": 1,
    });
    expect(countWorkEntries()).toBe(6);
  });
});

describe("로컬 터미널 진입점 (#2774)", () => {
  it("브라우저(데스크탑 아님)이고 작업 표면이 없으면 헤더에 터미널 버튼이 없다", async () => {
    shell.desktop = false;
    workFlag.provided = false;
    const host = await mount();
    expect(host.querySelectorAll('[data-testid="open-terminal-dock"]').length).toBe(0);
  });

  it("데스크탑이면 작업 표면이 없어도 버튼이 서고, 누르면 로컬 도크를 연다(관전 도크가 아니다)", async () => {
    shell.desktop = true;
    workFlag.provided = false;
    const host = await mount();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="open-terminal-dock"]');
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-keyshortcuts")).toBe("Control+`");
    act(() => button?.click());
    expect(dockSnapshot().open).toBe(true);
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[data-testid="observer-dock-stub"]')).toBeNull();
  });

  it("데스크탑에서는 작업 표면이 있어도 헤더가 관전 도크를 열지 않는다(로컬 도크가 대체)", async () => {
    shell.desktop = true;
    workFlag.provided = true;
    const host = await mount();
    act(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="open-terminal-dock"]')?.click()
    );
    expect(dockSnapshot().open).toBe(true);
    expect(host.querySelector('[data-testid="observer-dock-stub"]')).toBeNull();
  });

  it("브라우저에서 작업 표면이 있으면 지금까지대로 관전 도크를 연다", async () => {
    shell.desktop = false;
    workFlag.provided = true;
    const host = await mount();
    act(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="open-terminal-dock"]')?.click()
    );
    expect(dockSnapshot().open).toBe(false);
    expect(host.querySelector('[data-testid="observer-dock-stub"]')).not.toBeNull();
  });
});

describe("작업 표면 런타임 판정: 온라인 호스트 (#2780)", () => {
  it("정적 표가 접혀 있고 온라인 호스트가 없으면 진입점이 0이다", async () => {
    workFlag.provided = false;
    hostList.hosts = [
      onlineHost({ online: false }),
      onlineHost({
        id: "00000000-0000-7000-8000-000000000302",
        revokedAtMs: 1_800_000_000_000,
      }),
    ];
    await mount();
    await hostsSettled();
    expect(entryCounts()).toEqual({
      "nav-work-console": 0,
      "nav-workstreams": 0,
      "switcher-work-console": 0,
      "switcher-workstreams": 0,
      "settings-nav-code": 0,
      "open-terminal-dock": 0,
    });
  });

  it("정적 표가 접혀 있어도 온라인 호스트가 있으면 작업 콘솔·설정·관전 도크가 선다(작업 흐름은 아니다)", async () => {
    workFlag.provided = false;
    hostList.hosts = [onlineHost({ online: false }), onlineHost()];
    await mount();
    await hostsSettled();
    await vi.waitFor(() => {
      expect(entryCounts()).toEqual({
        "nav-work-console": 1,
        "nav-workstreams": 0,
        "switcher-work-console": 1,
        "switcher-workstreams": 0,
        "settings-nav-code": 1,
        "open-terminal-dock": 1,
      });
    });
  });

  it("데스크탑 로컬 터미널은 호스트가 없어도 선다(ADR-0190)", async () => {
    shell.desktop = true;
    workFlag.provided = false;
    hostList.hosts = [];
    const host = await mount();
    await hostsSettled();
    expect(
      host.querySelectorAll('[data-testid="open-terminal-dock"]').length
    ).toBe(1);
    expect(entryCounts()["nav-work-console"]).toBe(0);
  });
});
