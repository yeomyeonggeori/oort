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
import type { Approval, Channel, RosterMember, WorkHost } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { WORK_SURFACE_IDS } from "@momo/core/features/capabilities/serverSurfaces";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { SettingsRoute } from "@/features/settings/SettingsRoute";
import { ChatShell } from "@/features/chat/ChatShell";
import { WORK_HOST_OFFLINE_GRACE_MS } from "./useSurfaceProvided";
import { paneAttention } from "@/features/workbench/local/paneAttention";
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
// #3337: 「나에게 필요한 일」 시험이 쓰는 대기 승인. 진짜 `useNeedsAction` 경로로 흐른다.
const pendingApprovals: { rows: Approval[] } = { rows: [] };

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchWorkHosts: async () => hostList.hosts,
    fetchWorkSessions: async () => [],
    fetchApprovals: async (_ws: string, status: string) =>
      status === "pending" ? pendingApprovals.rows : [],
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
  // 레일(#3280)은 아바타만 선 컴팩트 카드를 쓴다. 그 자리만 표시해 둔다.
  ProfileCard: ({ compact }: { compact?: boolean }) =>
    compact ? createElement("span", { "data-testid": "profile-card" }) : null,
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

const readStateRows: { rows: { channelId: string; unreadCount: number; mentionCount: number }[] } = {
  rows: [],
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
      // 인박스 레일 배지(#3280)가 합산하는 서버 읽음 상태.
      data: readStateRows.rows,
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

let rerenderRail: (listInRoute: boolean) => void = () => undefined;

async function mount(
  {
    listInRoute = false,
    entry = "/",
    switcherOpen = true,
    collapsed = false,
    mentions = 0,
  }: {
    listInRoute?: boolean;
    entry?: string;
    switcherOpen?: boolean;
    collapsed?: boolean;
    mentions?: number;
  } = {}
): Promise<HTMLElement> {
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
  readStateRows.rows =
    mentions > 0 ? [{ channelId: CH, unreadCount: mentions, mentionCount: mentions }] : [];
  mountedClient = client;
  const tree = (listInRoute: boolean): ReactElement => createElement(
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
          { initialEntries: [entry] },
          createElement(
            "div",
            null,
            createElement(Sidebar, {
              onOpenQuickSwitcher: () => undefined,
              channelPaneCollapsed: collapsed,
              treeHidden: collapsed,
              listInRoute,
            }),
            createElement(QuickSwitcher, {
              // 열린 팔레트는 모달이라 캐럿을 붙든다. 캐럿 시험(H1)만 닫고 잰다.
              open: switcherOpen,
              onOpenChange: () => undefined,
            }),
            createElement(SettingsRoute),
            createElement(ChatShell)
          )
        )
      )
    )
  );
  rerenderRail = (next: boolean) => mountedRoot?.render(tree(next));
  await act(async () => {
    mountedRoot?.render(tree(listInRoute));
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
  pendingApprovals.rows = [];
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

describe("열린 관전 도크는 호스트가 잠깐 오프라인이 돼도 바로 내려가지 않는다 (#2893)", () => {
  const GRACE = WORK_HOST_OFFLINE_GRACE_MS;
  afterEach(() => {
    vi.useRealTimers();
  });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  async function goOffline(): Promise<void> {
    hostList.hosts = [onlineHost({ online: false })];
    await act(async () => {
      const done = mountedClient?.refetchQueries({ queryKey: ["work-hosts", WS] });
      await vi.advanceTimersByTimeAsync(1);
      await done;
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      mountedClient?.getQueryData<WorkHost[]>(["work-hosts", WS])?.[0]?.online
    ).toBe(false);
  }

  async function mountWithHost(): Promise<HTMLElement> {
    shell.desktop = false;
    workFlag.provided = false;
    hostList.hosts = [onlineHost()];
    const host = await mount();
    await hostsSettled();
    await vi.waitFor(() => expect(entryCounts()["open-terminal-dock"]).toBe(1));
    return host;
  }

  it("열어 둔 도크와 그 버튼은 유예 동안 남고, 지나면 함께 접힌다", async () => {
    const host = await mountWithHost();
    act(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="open-terminal-dock"]')?.click()
    );
    expect(host.querySelector('[data-testid="observer-dock-stub"]')).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    await goOffline();
    await advance(GRACE - 1_000);
    expect(host.querySelector('[data-testid="observer-dock-stub"]')).not.toBeNull();
    expect(entryCounts()["open-terminal-dock"]).toBe(1);
    // 닫힌 진입점(사이드바)은 유예하지 않는다: 누른 뒤 빈 화면을 만나지 않게.
    expect(entryCounts()["nav-work-console"]).toBe(0);

    await advance(2_000);
    expect(host.querySelector('[data-testid="observer-dock-stub"]')).toBeNull();
    expect(entryCounts()["open-terminal-dock"]).toBe(0);
  });

  it("도크가 닫혀 있으면 버튼은 유예 없이 바로 접힌다", async () => {
    await mountWithHost();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await goOffline();
    expect(entryCounts()["open-terminal-dock"]).toBe(0);
  });
});

describe("남의 개인 호스트도 관전·관제 진입점을 연다 (#2854 planner 결정 (a))", () => {
  const OTHER = "00000000-0000-7000-8000-000000000102";

  // 서버는 채널 멤버에게 남의 개인 호스트 세션의 목록과 관전을 허락한다. 좁히는
  // 판정(`isWorkHostUsableBy`)은 일을 시키는 표면(세션 이어받기)에만 쓴다.
  it("다른 멤버의 개인 호스트만 온라인이어도 작업 콘솔·⌘K·관전 도크가 선다", async () => {
    workFlag.provided = false;
    hostList.hosts = [onlineHost({ scope: "member", ownerMemberId: OTHER })];
    await mount();
    await hostsSettled();
    await vi.waitFor(() => {
      expect(entryCounts()["nav-work-console"]).toBe(1);
      expect(entryCounts()["switcher-work-console"]).toBe(1);
      expect(entryCounts()["open-terminal-dock"]).toBe(1);
    });
  });
});

describe("펼침: 레일은 워크스페이스 전용, 목적지는 목록 열의 「검색과 이동」 아래 (#3334)", () => {
  function rowCount(host: HTMLElement, id: string): number {
    return host.querySelectorAll(`[data-testid="${id}"]`).length;
  }
  const labelsIn = (host: HTMLElement, selector: string) =>
    [...host.querySelectorAll(`${selector} a`)].map((a) => a.textContent?.replace(/\d+$/, "").trim());
  const RAIL_DEST_IDS = ["rail-chat", "rail-inbox", "rail-agents", "rail-mine", "rail-team"];

  it("레일에는 워크스페이스 타일·「+」·프로필만 있고 목적지·구분선은 없다", async () => {
    shell.desktop = true;
    const host = await mount({ switcherOpen: false });
    const rail = host.querySelector('[data-testid="workspace-rail"]')!;
    for (const id of ["workspace-current", "add-workspace", "profile-card"]) {
      expect(rail.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    for (const id of [...RAIL_DEST_IDS, "rail-divider", "rail-destinations"]) {
      expect(rail.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
  });

  it("목록 열 머리 구획 A·B가 「검색과 이동」 바로 아래, 채널 목록 위에 선다", async () => {
    shell.desktop = true;
    workFlag.provided = false;
    hostList.hosts = [];
    const host = await mount({ switcherOpen: false });
    await hostsSettled();
    const head = host.querySelector('[data-testid="sidebar-list-head"]')!;
    const search = host.querySelector('[data-testid="open-quick-switcher"]')!;
    const channels = host.querySelector('[data-testid="channel-list"]')!;
    // 문서 순서: 검색 → 머리 → 채널 목록.
    expect(search.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(head.compareDocumentPosition(channels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labelsIn(head as HTMLElement, '[data-testid="sidebar-destinations"] nav')).toEqual([
      "대화",
      "인박스",
      "멤버",
    ]);
    expect(
      [...head.querySelectorAll('[data-testid="sidebar-section-agent-work"] a')].map((a) =>
        a.textContent?.replace(/\d+$/, "").trim()
      )
    ).toEqual(["에이전트", "내 작업", "팀 작업", "활동"]);
    expect(head.querySelector('[data-testid="nav-team"]')?.getAttribute("href")).toBe("/work?view=team");
    expect(
      head.querySelector('[data-testid="sidebar-section-agent-work-header"]')?.textContent
    ).toContain("에이전트·작업");
  });

  it("웹에서도 「내 작업」 줄이 선다(누르면 설명 상태가 열린다)", async () => {
    shell.desktop = false;
    const host = await mount({ switcherOpen: false });
    expect(rowCount(host, "nav-mine")).toBe(1);
    expect(host.querySelector('[data-testid="nav-mine"]')?.getAttribute("href")).toBe("/work");
  });

  it("「메시지 검색」 줄이 없다: 서버가 검색을 싣고 있어도 ⌘K가 대신한다", async () => {
    // 서버가 메시지 검색 표면을 싣는 경우에도(옛 줄의 조건) 줄은 서지 않는다. 줄이 다시
    // 세워지면(`nav-search`) 이 시험이 붉다.
    const host = await mount({ switcherOpen: false });
    expect(rowCount(host, "nav-search")).toBe(0);
    expect(host.querySelector('[data-testid="sidebar"] a[href="/search"]')).toBeNull();
    expect(host.querySelector('[data-testid="sidebar"]')?.textContent).not.toContain("메시지 검색");
    // 검색과 이동 입구는 그대로다.
    expect(rowCount(host, "open-quick-switcher")).toBe(1);
  });

  it("데스크탑에서 호스트가 있으면 작업 콘솔은 `?view=console`로 간다(`/work`는 격자다)", async () => {
    shell.desktop = true;
    workFlag.provided = false;
    hostList.hosts = [onlineHost()];
    const host = await mount();
    await hostsSettled();
    await vi.waitFor(() => expect(rowCount(host, "nav-work-console")).toBe(1));
    expect(host.querySelector('[data-testid="nav-work-console"]')?.getAttribute("href")).toBe(
      "/work?view=console"
    );
  });

  it("웹에서도 작업 콘솔은 `?view=console`이다(`/work`는 「내 작업」 설명 상태다)", async () => {
    shell.desktop = false;
    workFlag.provided = false;
    hostList.hosts = [onlineHost()];
    const host = await mount();
    await hostsSettled();
    await vi.waitFor(() => expect(rowCount(host, "nav-work-console")).toBe(1));
    expect(host.querySelector('[data-testid="nav-work-console"]')?.getAttribute("href")).toBe(
      "/work?view=console"
    );
  });

  it.each([
    ["/", "nav-chat"],
    ["/c/" + CH, "nav-chat"],
    ["/inbox", "nav-inbox"],
    ["/agents", "nav-agents"],
    ["/directory", "nav-directory"],
    ["/activity", "nav-activity"],
    ["/work", "nav-mine"],
    ["/work?view=team", "nav-team"],
  ])("%s 에서는 머리의 %s 하나만 aria-current다", async (entry, testId) => {
    shell.desktop = true;
    const host = await mount({ entry, switcherOpen: false });
    const current = [
      ...host.querySelectorAll('[data-testid="sidebar-list-head"] [aria-current="page"]'),
    ].map((a) => a.getAttribute("data-testid"));
    expect(current).toEqual([testId]);
  });

  it("안 읽은 멘션 수는 인박스 줄의 잉크 알약으로 서고 이름에 뜻이 붙는다", async () => {
    const host = await mount({ mentions: 3, switcherOpen: false });
    const row = host.querySelector('[data-testid="nav-inbox"]')!;
    await vi.waitFor(() =>
      expect(row.querySelector('[data-testid="mention-badge"]')?.textContent).toBe("3")
    );
    expect(row.getAttribute("aria-label")).toBe("인박스, 나에게 필요한 일 3개");
    // 0이면 알약도, 이름 덮어쓰기도 없다.
    const quiet = await mount({ switcherOpen: false });
    expect(quiet.querySelector('[data-testid="nav-inbox"] [data-testid="mention-badge"]')).toBeNull();
    expect(quiet.querySelector('[data-testid="nav-inbox"]')?.hasAttribute("aria-label")).toBe(false);
  });
});

describe("접힘(⌘B): 레일이 목적지 아이콘 다섯을 이어 붙인다 (#3334)", () => {
  const RAIL_DEST_IDS = ["rail-chat", "rail-inbox", "rail-agents", "rail-mine", "rail-team"];
  const railIcons = (host: HTMLElement) =>
    [...host.querySelectorAll('[data-testid="workspace-rail"] nav[aria-label="앱 탐색"] a')].map((a) =>
      a.getAttribute("data-testid")
    );

  it.each([true, false])("접히면 구분선 아래 다섯 목적지가 모두 선다 (desktop=%s)", async (desktop) => {
    // 「내 작업」은 웹에서도 선다: 하나라도 빠지면 접힌 동안 그 목적지로 갈 길이 사라진다.
    shell.desktop = desktop;
    const host = await mount({ collapsed: true, switcherOpen: false });
    expect(railIcons(host)).toEqual(RAIL_DEST_IDS);
    const rail = host.querySelector('[data-testid="workspace-rail"]')!;
    expect(rail.querySelector('[data-testid="rail-divider"]')).not.toBeNull();
    // 워크스페이스 타일·「+」·프로필은 접힘에서도 그대로다.
    for (const id of ["workspace-current", "add-workspace", "profile-card"]) {
      expect(rail.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    // 아이콘마다 이름(글자)이 있다: 이름 없는 아이콘이 「내 작업」이 어디 갔는지 모르게 했다.
    expect(
      [...rail.querySelectorAll('nav[aria-label="앱 탐색"] a')].map((a) => a.textContent)
    ).toEqual(["대화", "인박스", "에이전트", "내 작업", "팀 작업"]);
  });

  it("접힌 인박스 아이콘의 배지가 나에게 필요한 일 수다", async () => {
    const host = await mount({ collapsed: true, mentions: 3, switcherOpen: false });
    const tile = host.querySelector('[data-testid="rail-inbox"]')!;
    await vi.waitFor(() =>
      expect(tile.querySelector('[data-testid="rail-inbox-badge"]')?.textContent).toBe("3")
    );
    expect(tile.getAttribute("aria-label")).toBe("인박스, 나에게 필요한 일 3개");
  });

  it("접힘에서 지금 있는 목적지 하나만 aria-current다", async () => {
    shell.desktop = true;
    const host = await mount({ collapsed: true, entry: "/work?view=team", switcherOpen: false });
    const current = [
      ...host.querySelectorAll('[data-testid="workspace-rail"] [aria-current="page"]'),
    ].map((a) => a.getAttribute("data-testid"));
    expect(current).toEqual(["rail-team"]);
  });
});

describe("나에게 필요한 일 = 인박스 알약 단일 출처 (#3337, #3334)", () => {
  const approval = (id: string): Approval => ({
    id,
    workspaceId: WS,
    runId: "run-1",
    channelId: CH,
    requestedBy: self.id,
    actionType: "tool_call",
    status: "pending",
  });

  const badge = (host: HTMLElement) =>
    host.querySelector('[data-testid="nav-inbox"] [data-testid="mention-badge"]')?.textContent;
  const railBadge = (host: HTMLElement) =>
    host.querySelector('[data-testid="rail-inbox"] [data-testid="rail-inbox-badge"]')?.textContent;

  it("멘션 2 + 대기 승인 2 + 응답 필요 칸 1 = 5, 펼침의 줄과 접힘의 아이콘이 같은 수다", async () => {
    shell.desktop = true;
    pendingApprovals.rows = [approval("ap-1"), approval("ap-2")];
    const store = paneAttention();
    act(() => {
      store.observe(
        [{ paneId: "pane-wait", index: 1, name: "claude", status: "waiting", signal: null }],
        null
      );
    });
    try {
      const host = await mount({ mentions: 2, switcherOpen: false });
      await vi.waitFor(() => expect(badge(host)).toBe("5"));
      const folded = await mount({ mentions: 2, collapsed: true, switcherOpen: false });
      await vi.waitFor(() => expect(railBadge(folded)).toBe("5"));
    } finally {
      act(() => store.observe([], null));
    }
  });

  it("승인만 있어도 알약이 선다 (멘션만 세던 옛 배지는 0이었다)", async () => {
    pendingApprovals.rows = [approval("ap-1")];
    const host = await mount({ switcherOpen: false });
    await vi.waitFor(() => expect(badge(host)).toBe("1"));
  });

  it("같은 승인이 원장에서 두 번 와도 한 번만 센다", async () => {
    pendingApprovals.rows = [approval("ap-1"), approval("ap-1")];
    const host = await mount({ switcherOpen: false });
    await vi.waitFor(() => expect(badge(host)).toBe("1"));
  });

  it("웹(데스크탑 아님)에서는 응답 필요 칸이 있어도 세지 않는다", async () => {
    shell.desktop = false;
    const store = paneAttention();
    act(() => {
      store.observe(
        [{ paneId: "pane-wait", index: 1, name: "claude", status: "waiting", signal: null }],
        null
      );
    });
    try {
      const host = await mount({ switcherOpen: false });
      await act(async () => {
        await Promise.resolve();
      });
      expect(badge(host)).toBeUndefined();
    } finally {
      act(() => store.observe([], null));
    }
  });
});

describe("레일과 목록 열 머리는 탭마다 바뀌지 않는다 (#3280, #3334)", () => {
  const click = (host: HTMLElement, testId: string) =>
    act(() => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click());

  it("대화 → 인박스 → 팀 작업 → 내 작업 → 대화: 머리와 그 안의 모든 줄이 같은 DOM 노드다", async () => {
    shell.desktop = true;
    const host = await mount({ switcherOpen: false });
    const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const ROWS = ["nav-chat", "nav-inbox", "nav-directory", "nav-agents", "nav-mine", "nav-team", "nav-activity"];
    const head = q("sidebar-list-head")!;
    const destinations = q("sidebar-destinations")!;
    const rows = ROWS.map((id) => q(id)!);
    const rail = q("workspace-rail")!;
    const search = q("open-quick-switcher")!;
    const bodySlot = q("sidebar-body-slot")!;
    const expectSame = (step: string) => {
      expect(q("sidebar-list-head"), `${step}: 머리`).toBe(head);
      expect(q("sidebar-destinations"), `${step}: 구획 A·B`).toBe(destinations);
      ROWS.forEach((id, i) => expect(q(id), `${step}: ${id}`).toBe(rows[i]));
      expect(q("workspace-rail"), `${step}: 레일`).toBe(rail);
      expect(q("open-quick-switcher"), `${step}: 검색`).toBe(search);
      expect(q("sidebar-body-slot"), `${step}: 본문 자리(언마운트 없이 숨김만)`).toBe(bodySlot);
      expect(q("sidebar-channel-pane")?.hidden, `${step}: 목록 열은 숨지 않는다`).toBe(false);
      expect(q("workspace-rail")?.querySelector('[data-testid="rail-destinations"]'), `${step}: 펼침 레일에 목적지 없음`).toBeNull();
    };
    click(host, "nav-inbox");
    expectSame("인박스");
    click(host, "nav-team");
    expectSame("팀 작업");
    // 팀 작업의 본문은 채널 목록이 아니라 팀 세션 목록이다(머리는 그대로).
    expect(q("sidebar-team-sessions")).not.toBeNull();
    expect(q("channel-list")?.hidden).toBe(true);
    act(() => rerenderRail(true)); // 데스크탑 「내 작업」: 셸이 listInRoute를 켠다
    expectSame("내 작업");
    expect(q("sidebar-body-slot")?.hidden).toBe(false);
    expect(q("channel-list")?.hidden).toBe(true);
    act(() => rerenderRail(false));
    click(host, "nav-chat");
    expectSame("대화");
    expect(q("channel-list")?.hidden).toBe(false);
    expect(q("sidebar-team-sessions")).toBeNull();
  });

  it("「내 작업」으로 들어가도 레일은 같은 노드·숨김 없음이고 본문 자리만 바뀐다", async () => {
    shell.desktop = true;
    const host = await mount({ entry: "/work", listInRoute: false, switcherOpen: false });
    const railBefore = host.querySelector<HTMLElement>('[data-testid="workspace-rail"]')!;
    const tileBefore = host.querySelector('[data-testid="workspace-current"]');
    expect(host.querySelector<HTMLElement>('[data-testid="sidebar-channel-pane"]')?.hidden).toBe(false);

    act(() => rerenderRail(true));

    const railAfter = host.querySelector<HTMLElement>('[data-testid="workspace-rail"]')!;
    expect(railAfter).toBe(railBefore); // 같은 DOM 노드(언마운트·교체 없음)
    expect(host.querySelector('[data-testid="workspace-current"]')).toBe(tileBefore);
    expect(railAfter.hidden).toBe(false);
    expect(railAfter.closest("[inert]")).toBeNull();
    expect(host.querySelector('[data-testid="work-rail"]')).toBeNull(); // 64px 작업 레일은 없다
    expect(railAfter.querySelector('[data-testid="add-workspace"]')).not.toBeNull();
    // 목록 열은 숨지 않는다(#3334): 바뀌는 것은 본문 자리뿐이다(채널 트리 → 라우트의 세션 목록).
    expect(host.querySelector<HTMLElement>('[data-testid="sidebar-channel-pane"]')?.hidden).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-testid="channel-list"]')?.hidden).toBe(true);
    expect(host.querySelector('[data-testid="channel-list"]')).not.toBeNull(); // 언마운트하지 않는다
  });

  it("접히면 목록 열만 숨고 레일은 그대로 서 있고 탭 순서에 남는다", async () => {
    shell.desktop = true;
    const host = await mount({ collapsed: true, switcherOpen: false });
    const rail = host.querySelector<HTMLElement>('[data-testid="workspace-rail"]')!;
    expect(rail.hidden).toBe(false);
    expect(rail.closest("[inert]")).toBeNull();
    expect(host.querySelector('[data-testid="sidebar"]')?.hasAttribute("inert")).toBe(false);
    const pane = host.querySelector<HTMLElement>('[data-testid="sidebar-channel-pane"]')!;
    expect(pane.hidden).toBe(true);
    expect(pane.hasAttribute("inert")).toBe(true);
  });
});
