// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, Channel, RosterMember } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import {
  markAgentWorking,
  resetAgentWorking,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import { Sidebar } from "./Sidebar";

// =============================================================================
// 사이드바 「작업 중」 카드도 승인 원장 덮어쓰기를 지난다 (#5125, #3738 후속).
//
// 서버는 승인에 걸린 run 을 레일 프레임으로 알리지 않는다(중간 프레임은 늘 `running`). 같은 사이드바의 채널 행 알약은 승인 원장으로 그것을
// 「승인 필요」로 덮지만(#3738), 맨 위 카드는 스토어의 원본 신호를 읽어서 사람의 결정을 기다리는 에이전트를 「작업 중」이라고 말했다 —
// 한 사이드바 안에서 같은 에이전트를 두 낱말로 말했다. 이 시험은 진짜 `Sidebar` 를 그리고 **카드에 그려진 낱말**을 잰다. 원장은 진짜 쿼리
// 경로(`useApprovalWaits` → `fetchApprovals`)로 들어온다.
// =============================================================================

const api = vi.hoisted(() => ({ fetchApprovals: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, fetchApprovals: api.fetchApprovals };
});

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_ENGINE = "00000000-0000-7000-8000-000000000201";
const AGENT = "00000000-0000-7000-8000-000000000301";

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
  ProfileCard: () => createElement("span", { "data-testid": "profile-card" }),
}));

vi.mock("./WorkspaceRail", () => ({
  WorkspaceRail: () => createElement("div", { "data-testid": "workspace-rail" }),
}));

vi.mock("@/app/ShortcutHelpDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/ShortcutHelpDialog")>()),
  ShortcutHelpDialog: () => null,
}));

vi.mock("@/features/drafts/DraftsNavItem", () => ({
  DraftsNavItem: () => null,
}));

// 새 DM 모달의 문은 셸(NewDmProvider)이 내리는 동사다. 이 시험은 셸 없이 그리므로 문만 막아 둔다.
vi.mock("@/features/directory/useNewDm", () => ({
  useOpenNewDm: () => () => undefined,
  useNewDmOpen: () => false,
}));

const engine: Channel = {
  id: CH_ENGINE,
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
  displayName: "시험 사용자",
  handle: "tester",
  role: "owner",
  channelCount: 1,
  channelIds: [CH_ENGINE],
  capabilities: [],
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

const agent: RosterMember = {
  id: AGENT,
  workspaceId: WS,
  kind: "agent",
  status: "active",
  displayName: "달무리봇",
  handle: "dalmuri-bot",
  channelCount: 1,
  channelIds: [CH_ENGINE],
  capabilities: [],
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
};

const directory = makeDirectory([self, agent]);
const channelsQuery = {
  isLoading: false,
  isPending: false,
  error: null as Error | null,
  refetch: () => undefined,
  groups: { channels: [engine], dms: [] as Channel[] },
  data: [engine] as Channel[],
};

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsQuery,
    useDirectory: () => ({ directory, isPending: false, isLoading: false }),
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

vi.mock("@momo/core/features/settings/notificationRules", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/settings/notificationRules")>();
  return {
    ...actual,
    fetchNotificationRules: async () => ({ dnd: false, mentionOverridesMute: false }),
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

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "시험 사용자",
        handle: "tester",
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

async function mountSidebar(ledger: Approval[]): Promise<HTMLElement> {
  // 서버처럼 답한다: `status=pending` 쪽은 결정 대기인 행만 돌려준다.
  api.fetchApprovals.mockImplementation(async (_workspaceId: string, status: string) =>
    ledger.filter((approval) => approval.status === status)
  );
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(
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
              createElement(Sidebar, {
                onOpenQuickSwitcher: () => undefined,
                channelPaneCollapsed: false,
                treeHidden: false,
              })
            )
          )
        )
      )
    );
    await Promise.resolve();
  });
  return host;
}

/** 레일이 말하는 열린 턴: 서버 프레임이 `running` 이라고 한 에이전트. */
function railTurn(over: Partial<AgentWorkingSignal> = {}): AgentWorkingSignal {
  return {
    memberId: AGENT,
    channelId: CH_ENGINE,
    state: "working",
    source: "run",
    runId: "run-301",
    startedAtMs: Date.now() - 30_000,
    headlines: ["설계 문서 읽는 중"],
    lastActivityAtMs: Date.now(),
    ...over,
  };
}

function waitingApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: "ap-301",
    workspaceId: WS,
    runId: "run-301",
    channelId: CH_ENGINE,
    requestedBy: AGENT,
    actionType: "tool_call",
    status: "pending",
    expiresAtMs: Date.now() + 3_600_000,
    createdAtMs: Date.now(),
    ...over,
  } as Approval;
}

/** 원장 응답이 도착해 화면이 다시 그려질 때까지, 한 번에 act 하나씩 흘려 보내며 기다린다(act 밖 갱신 경고 없이). */
const eventually = (check: () => void) =>
  vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    check();
  });

const card = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-testid="sidebar-now-card"]');
const word = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[data-testid="sidebar-now-state"]')?.textContent?.trim();
const placeLine = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[data-testid="sidebar-now-line"]')?.textContent ?? "";

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  resetAgentWorking();
  api.fetchApprovals.mockReset();
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
  resetAgentWorking();
  vi.unstubAllGlobals();
});

describe("사이드바 작업 중 카드가 승인 원장을 따른다 (#5125)", () => {
  it("레일은 일하는 중이라는데 이 에이전트가 올린 승인이 사람을 기다리면 카드는 「승인 필요」를 말하고 쓰던 한 줄은 버린다", async () => {
    markAgentWorking(railTurn());
    const host = await mountSidebar([waitingApproval()]);

    // 원장이 읽혀 덮어쓰기가 서기를 기다린다. 덮이지 않으면 카드는 레일이 말하는 「작업 중」이다.
    await eventually(() => {
      expect(word(host)).toBe("승인 필요");
    });
    expect(card(host)?.getAttribute("data-state")).toBe("awaiting_approval");
    expect(placeLine(host)).toContain("#엔진");
    expect(placeLine(host)).not.toContain("설계 문서 읽는 중");
  });

  it("레일이 아무 턴도 모르는데 사람을 기다리는 승인이 있으면 승인이 카드를 세운다 — 기한이 지난 승인은 세우지 않는다", async () => {
    // 승인 하나는 기다리는 중이고, 하나는 기한이 지났다(서버가 정리하기 전의 몇 초: 서버는 아직 `pending` 이라고 답한다).
    const host = await mountSidebar([
      waitingApproval(),
      waitingApproval({ id: "ap-302", requestedBy: MEMBER_ID, expiresAtMs: Date.now() - 60_000 }),
    ]);

    await eventually(() => {
      expect(card(host)).not.toBeNull();
    });
    expect(word(host)).toBe("승인 필요");
    expect(card(host)?.getAttribute("data-state")).toBe("awaiting_approval");
    expect(placeLine(host)).toBe("#엔진");
  });
});
