// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { holdGlobalShortcuts } from "@/app/globalShortcutHold";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, ReadState, RosterMember } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { Sidebar } from "./Sidebar";
import { REVIVAL_RETRY_DELAY_MS } from "./dmRevival";
import { GONE_UNREAD_RETRY_DELAY_MS } from "./goneUnreadVerdicts";
import { DM_CLOSURE_CACHE_KEY, DM_CLOSURE_MIGRATED_KEY, resetDmClosureFoldForTest } from "./dmClosureModel";
import { resetDmMigrationForTest } from "./useDmVisibility";
import {
  closeDmOnDevice,
  closedAtSeqOf,
  closedDmsFor,
  reloadClosedDmsForTest,
} from "./sidebarDmClosure";

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const CH_GENERAL = "00000000-0000-7000-8000-000000000202";

vi.mock("@/features/workspace/useAddWorkspace", () => ({
  useOpenAddWorkspace: () => () => undefined,
}));

vi.mock("@/features/channels/useCreateChannel", () => ({
  useOpenCreateChannel: () => () => undefined,
  useCreateChannelOpen: () => false,
}));

const openNewDm = vi.fn();
vi.mock("@/features/directory/useNewDm", () => ({
  useOpenNewDm: () => openNewDm,
  useNewDmOpen: () => false,
}));

/** 터치(hover: none) 표면을 시험이 켠다. 기본은 포인터다. */
const touch = vi.hoisted(() => ({ hoverNone: false }));
vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => touch.hoverNone,
}));

vi.mock("./ProfileCard", () => ({
  ProfileCard: () => null,
}));

vi.mock("./WorkspaceRail", () => ({
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

const PEER_PLAIN = "00000000-0000-7000-8000-000000000111";
const PEER_PHOTO = "00000000-0000-7000-8000-000000000112";
const PEER_AWAY = "00000000-0000-7000-8000-000000000113";
const PEER_AGENT = "00000000-0000-7000-8000-000000000114";
const GHOST = "00000000-0000-7000-8000-000000000199";

const NOW = 1_800_000_000_000;
function member(id: string, patch: Partial<RosterMember>): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...patch,
  };
}
const self = member(MEMBER_ID, { displayName: "곽성재", handle: "seongjae", role: "owner" });
const roster = [
  self,
  member(PEER_PLAIN, { displayName: "이도현", handle: "dohyun" }),
  member(PEER_PHOTO, { displayName: "박서연", handle: "seoyeon", avatarUrl: "/media/seoyeon.png" }),
  member(PEER_AWAY, { displayName: "최민수", handle: "minsu", presenceStatus: "away" }),
  member(PEER_AGENT, { displayName: "김인턴", handle: "intern", kind: "agent", hostOnline: true }),
];

function dm(id: string, others: string[]): Channel {
  return {
    id,
    workspaceId: WS,
    kind: "dm",
    name: undefined,
    memberIds: [MEMBER_ID, ...others],
    muted: false,
  } as Channel;
}
const DM_ID = (n: number) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;
const dms: Channel[] = [
  dm(DM_ID(1), [PEER_PLAIN]),
  dm(DM_ID(2), [PEER_PHOTO]),
  dm(DM_ID(3), [PEER_AWAY]),
  dm(DM_ID(4), [PEER_AGENT]),
  dm(DM_ID(5), []),
  dm(DM_ID(6), [GHOST]),
];
const general: Channel = {
  id: CH_GENERAL,
  workspaceId: WS,
  kind: "public",
  name: "일반",
  muted: false,
};

const channelsQuery = {
  isLoading: false,
  isPending: false,
  error: null as Error | null,
  refetch: () => undefined,
  groups: { channels: [general], dms: [] as Channel[] },
  data: [general] as Channel[],
};

/** 서버 읽음 투영의 대역. 닫은 DM 이 돌아오는 조건(latestSeq)과 투영의 국면을 시험이 돌린다. */
const readStatesQuery = {
  byChannel: new Map<string, ReadState>(),
  isPending: false,
  isError: false,
  data: [] as ReadState[] | undefined,
  refetch: (() => undefined) as () => unknown,
};

function readState(channelId: string, latestSeq: number, lastReadSeq = latestSeq): ReadState {
  return {
    channelId,
    lastReadSeq,
    latestSeq,
    unreadCount: Math.max(0, latestSeq - lastReadSeq),
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
  };
}

function setReadStates(states: ReadState[]) {
  readStatesQuery.byChannel = new Map(states.map((state) => [state.channelId.toLowerCase(), state]));
  readStatesQuery.data = states;
}

/**
 * 에이전트 생존 판정의 대역(#3964): id → 상태. 적지 않은 에이전트는 404(= 「라벨 없음」, 호스티드가 아님)다.
 * `"pending"` 은 응답이 오지 않는다(아직 모름).
 */
const liveness = vi.hoisted(() => ({ byAgent: new Map<string, string>() }));

/**
 * 닫은 뒤의 메시지 쪽의 대역(#4142). 적지 않은 DM 은 사람이 쓴 글 한 건이 있다(= 되살아난다).
 * `"fail"` 은 읽기가 실패한다. 호출 기록으로 「한 번만 읽는다」를 잡는다.
 */
type RevivalPage = Array<{ type: string; props?: Record<string, unknown> }>;
const revival = vi.hoisted(() => ({
  /** 채널 id(소문자) -> 쪽. 함수면 요청의 `after` 로 쪽을 고른다(같은 DM 을 되살림과 안 읽음 판정이 다른 `after` 로 읽을 때). */
  pages: new Map<string, "fail" | "pending" | RevivalPage | ((after: number | undefined) => RevivalPage)>(),
  calls: [] as Array<{ channelId: string; after?: number; limit?: number }>,
  /**
   * 채널 id(소문자) -> 문(#4273). 문이 닫혀 있는 동안 그 DM 의 읽기는 요청은 나가도(`calls` 에 남는다) 응답이 오지 않고, 시험이
   * `holdRevivalRead` 가 돌려준 함수로 열면 그때 적어 둔 쪽으로 끝난다. `"pending"` 은 영영 오지 않지만 이 문은 시험이 연다.
   * 「읽는 중」을 시간이 아니라 시험이 정한다: 응답이 마이크로태스크로 끝나는 대역에서는 `await rerender()` 가 돌아온 시점에
   * 읽기가 끝났는지가 이벤트 루프의 사정(react-query 알림 타이머와 `act` 복귀의 앞뒤)에 달려 부하에서 뒤집힌다.
   */
  holds: new Map<string, Promise<void>>(),
}));
/** DM 닫기 경로의 대역(ADR-0177 D7, #4228). `fail` 이 상태 코드면 그 코드로 거절하고, 네트워크 실패면 `"network"`. */
const closure = vi.hoisted(() => ({
  calls: [] as Array<{ kind: "PUT" | "DELETE"; channelId: string; seenSeq?: number }>,
  fail: null as number | "network" | null,
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  const answer = () => {
    if (closure.fail === "network") throw new Error("offline");
    if (closure.fail !== null) throw new actual.ApiError(closure.fail, "x");
  };
  return {
    ...actual,
    closeDm: async (_ws: string, channelId: string, seenSeq: number) => {
      closure.calls.push({ kind: "PUT", channelId: channelId.toLowerCase(), seenSeq });
      answer();
    },
    reopenDm: async (_ws: string, channelId: string) => {
      closure.calls.push({ kind: "DELETE", channelId: channelId.toLowerCase() });
      answer();
    },
    fetchMessages: async (_ws: string, channelId: string, query: { after?: number; limit?: number } = {}) => {
      revival.calls.push({ channelId: channelId.toLowerCase(), after: query.after, limit: query.limit });
      const hold = revival.holds.get(channelId.toLowerCase());
      if (hold !== undefined) await hold;
      const entry = revival.pages.get(channelId.toLowerCase()) ?? [{ type: "text" }];
      const page = typeof entry === "function" ? entry(query.after) : entry;
      if (page === "fail") throw new actual.ApiError(500, "boom");
      if (page === "pending") return new Promise<never>(() => undefined);
      return {
        messages: page.map((m, i) => ({
          id: `m${i}`,
          channelId,
          seq: (query.after ?? 0) + 1 + i,
          authorMemberId: "x",
          ...m,
        })),
      };
    },
    fetchAgentLiveness: async (_ws: string, agentId: string) => {
      const state = liveness.byAgent.get(agentId.toLowerCase());
      if (state === undefined) throw new actual.ApiError(404, "not found");
      if (state === "pending") return new Promise(() => undefined);
      return { agentMemberId: agentId, state };
    },
  };
});

/**
 * 명부(roster) 쿼리의 국면(#4252). `pending` 이면 명부가 비어 있고 아직 도착하지 않았다. `failed` 이면 한 번도 못 받은 채
 * 실패했다(`isError`, 데이터 없음). 둘 다 명부는 비어 있다.
 */
const rosterPhase = vi.hoisted(() => ({ pending: false, failed: false }));
/** 「다시 시도」가 다시 부르는 쿼리의 대역(#4252, design-review H2·M1). */
const refetchers = vi.hoisted(() => ({ roster: vi.fn(), read: vi.fn() }));

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsQuery,
    useDirectory: () => ({
      directory: makeDirectory(rosterPhase.pending || rosterPhase.failed ? [] : roster),
      isPending: rosterPhase.pending,
      isLoading: rosterPhase.pending,
      isError: rosterPhase.failed,
      data: undefined,
      refetch: refetchers.roster,
    }),
    useReadStates: () => readStatesQuery,
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

let queryClient: QueryClient | null = null;
let currentPath = "/";

function buildTree(): ReactElement {
  queryClient ??= new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(
    QueryClientProvider,
    { client: queryClient },
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
          { initialEntries: [currentPath] },
          createElement(Sidebar, {
            onOpenQuickSwitcher: () => undefined,
            channelPaneCollapsed: false,
            treeHidden: false,
          })
        )
      )
    )
  );
}

async function mount(initialPath = "/"): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  queryClient = null;
  currentPath = initialPath;
  await act(async () => {
    mountedRoot?.render(buildTree());
    await Promise.resolve();
  });
  return host;
}

/** 같은 트리를 다시 그린다(라우터 상태는 남는다). 훅 대역의 값을 바꾼 뒤에 쓴다. */
async function rerender(): Promise<void> {
  await act(async () => {
    mountedRoot?.render(buildTree());
    await Promise.resolve();
  });
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  rosterPhase.pending = false;
  rosterPhase.failed = false;
  liveness.byAgent.clear();
  revival.pages.clear();
  revival.calls.length = 0;
  revival.holds.clear();
  closure.calls.length = 0;
  closure.fail = null;
  resetDmClosureFoldForTest();
  resetDmMigrationForTest();
  touch.hoverNone = false;
  localStorage.clear();
  reloadClosedDmsForTest(null);
  readStatesQuery.isPending = false;
  readStatesQuery.isError = false;
  readStatesQuery.refetch = refetchers.read;
  refetchers.roster.mockClear();
  refetchers.read.mockClear();
  setReadStates([]);
  channelsQuery.isLoading = false;
  channelsQuery.groups = { channels: [general], dms };
  channelsQuery.data = [general, ...dms];
  openNewDm.mockClear();
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
  localStorage.clear();
  reloadClosedDmsForTest(null);
});


const dmRow = (host: HTMLElement, channelId: string) =>
  host.querySelector<HTMLElement>(`[data-testid="channel-item"][data-channel-id="${channelId}"]`)!;
const dmHeader = (host: HTMLElement) =>
  host.querySelector<HTMLElement>('[data-testid="sidebar-section-dms-header"]')!;
const hover = (el: HTMLElement) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
/**
 * 나간 멤버 DM 은 안 읽은 것이 없으면 목록에 없다(#4252, ADR-0177 D11). 그 행의 이름·아바타를 재려는 시험은 멘션을 하나 얹어 행이
 * 서게 한다(멘션은 사람이 직접 남긴 신호라 항상 보인다, 코어 5번).
 */
function showGhostRow(): void {
  setReadStates([{ ...readState(DM_ID(6), 1, 1), mentionCount: 1 }]);
}
const unmountForRemount = () => {
  act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
};
/**
 * DM 구역 머리 「⋯」 메뉴가 세는 「닫은 대화」 수(ADR-0177 D11, #4228). 「나간 멤버와의 대화 N개」 줄은 없어졌다: 나간 상대의 DM 은 안
 * 읽은 것이 없으면 목록에서 빠지고, 내가 닫은 대화와 함께 이 목록으로 간다. 닫은 대화가 없으면 메뉴 문이 서지 않는다(0).
 */
const closedCount = (host: HTMLElement) => {
  // 머리의 호버 클러스터는 쉴 때 DOM 에 없다(`data-section-action`): 호버해야 문이 선다.
  const header = dmHeader(host);
  if (header !== null) hover(header);
  return Number(
    host.querySelector<HTMLElement>('[data-testid="dm-section-menu"]')?.getAttribute("data-closed-count") ?? "0"
  );
};
/** 이 판에는 「나간 멤버와의 대화 N개」 줄이 어디에도 없다(수용기준 12). */
const foldLine = (host: HTMLElement) =>
  host.querySelector('[data-testid="gone-dm-toggle"]') ?? (host.textContent?.includes("나간 멤버와의 대화") ? host : null);

describe("사이드바 DM 구획 (#3662)", () => {
  it("「대화」 줄(nav-chat)은 없다 — 구획 A는 인박스·멤버부터다", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="nav-chat"]')).toBeNull();
    expect(host.querySelector('[data-testid="nav-inbox"]')).not.toBeNull();
    const labels = [...host.querySelectorAll('[data-testid="sidebar-destinations"] nav a')].map(
      (a) => a.textContent?.trim()
    );
    expect(labels).not.toContain("대화");
  });

  it("+는 쉴 때 없고, 머리에 호버하면 서며, 누르면 눌린 버튼을 들고 새 DM 모달을 연다", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="new-dm"]')).toBeNull();
    hover(dmHeader(host));
    const plus = host.querySelector<HTMLButtonElement>('[data-testid="new-dm"]');
    expect(plus).not.toBeNull();
    expect(plus!.tagName).toBe("BUTTON");
    expect(plus!.getAttribute("aria-label")).toBe("새 다이렉트 메시지 시작");
    act(() => plus!.click());
    expect(openNewDm).toHaveBeenCalledTimes(1);
    expect(openNewDm).toHaveBeenCalledWith(plus);
  });

  it("키보드로 머리 버튼에 닿으면(:focus-visible) 호버 없이도 +가 선다", async () => {
    const host = await mount();
    expect(host.querySelector('[data-testid="new-dm"]')).toBeNull();
    const real = HTMLElement.prototype.matches;
    const spy = vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (
      this: HTMLElement,
      selector: string
    ) {
      return selector === ":focus-visible" ? true : real.call(this, selector);
    });
    try {
      act(() => host.querySelector<HTMLElement>('[data-testid="section-collapse-dms"]')!.focus());
      expect(host.querySelector('[data-testid="new-dm"]')).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("DM이 하나도 없어도 구획과 +가 선다(문이 없는 빈 워크스페이스 방지)", async () => {
    channelsQuery.groups = { channels: [general], dms: [] };
    channelsQuery.data = [general];
    const host = await mount();
    expect(host.querySelector('[data-testid="sidebar-section-dms"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="dm-section-empty"]')).not.toBeNull();
    hover(dmHeader(host));
    expect(host.querySelector('[data-testid="new-dm"]')).not.toBeNull();
  });

  it("DM 행은 말풍선 아이콘이 아니라 상대의 아바타다: 사진 없으면 이니셜, 있으면 사진", async () => {
    const host = await mount();
    const plain = dmRow(host, DM_ID(1));
    expect(plain.textContent).toContain("이도현");
    expect(plain.querySelector("svg")).toBeNull();
    const plainAvatar = plain.querySelector('[data-testid="dm-avatar"]')!;
    expect(plainAvatar.getAttribute("data-avatar-kind")).toBe("human");
    expect(plainAvatar.textContent).toBe("이");
    expect(plainAvatar.querySelector("img")).toBeNull();

    const photo = dmRow(host, DM_ID(2)).querySelector('[data-testid="dm-avatar"]')!;
    expect(photo.querySelector("img")?.getAttribute("src")).toBe("/media/seoyeon.png");

    const agent = dmRow(host, DM_ID(4)).querySelector('[data-testid="dm-avatar"]')!;
    expect(agent.getAttribute("data-avatar-kind")).toBe("agent");
    expect(agent.textContent).toBe("김");
  });

  it("상태 점은 아는 것만: 자리 비움·연결된 에이전트는 점이 있고, 평범한 사람은 점이 없다", async () => {
    // 생존 판정이 없다(404)고 확정된 에이전트는 호스트 연결(`hostOnline`)만으로 점이 된다 (#3964).
    const host = await mount();
    await settle();
    const tone = (id: string) => dmRow(host, id).querySelector('[data-testid="dm-avatar"]')!.getAttribute("data-status-tone");
    expect(tone(DM_ID(1))).toBeNull();
    expect(tone(DM_ID(3))).toBe("warn");
    expect(tone(DM_ID(4))).toBe("ok");
    expect(dmRow(host, DM_ID(3)).textContent).toContain("자리 비움");
    expect(dmRow(host, DM_ID(3)).querySelector('[data-testid="dm-peer-dot"]')).not.toBeNull();
    expect(dmRow(host, DM_ID(4)).querySelector('[data-testid="dm-peer-dot"]')).not.toBeNull();
    expect(dmRow(host, DM_ID(1)).querySelector('[data-testid="dm-peer-dot"]')).toBeNull();
  });

  it("정체불명 「다이렉트 메시지」 행은 없다: 나 혼자의 DM은 「이름 (나)」, 명부에 없는 상대는 「나간 멤버」", async () => {
    const host = await mount();
    const labels = [...host.querySelectorAll('[data-testid="channel-item"]')].map((el) =>
      el.textContent?.trim()
    );
    expect(labels.filter((t) => t === "다이렉트 메시지")).toEqual([]);
    const selfRow = dmRow(host, DM_ID(5));
    expect(selfRow.textContent).toContain("곽성재 (나)");
    expect(selfRow.querySelector('[data-testid="dm-avatar"]')?.textContent).toBe("곽");
    // 명부에 없는 상대의 DM 은 안 읽음이 없으면 목록에 없다(#4252): 「닫은 대화」에 있다. 이름은 멘션이 행을 세운 판에서 잰다.
    expect(dmRow(host, DM_ID(6))).toBeNull();
    expect(closedCount(host)).toBe(1);
    unmountForRemount();
    showGhostRow();
    const withGhost = await mount();
    await settle();
    const ghostRow = dmRow(withGhost, DM_ID(6));
    expect(ghostRow.textContent).toContain("나간 멤버");
    expect(ghostRow.querySelector('[data-testid="dm-avatar"]')?.getAttribute("data-avatar-kind")).toBe("unknown");
  });
});

// =============================================================================
// DM 호버 X · 대화 닫기 (#3963)
// =============================================================================

/** 브라우저가 포인터가 행에 들어올 때 쏘는 것: 네이티브 mouseenter (SidebarRow 가 이것을 듣는다). */
const enterRow = (host: HTMLElement, channelId: string) =>
  act(() => {
    dmRow(host, channelId).closest("li")!.dispatchEvent(new MouseEvent("mouseenter"));
  });
const leaveRow = (host: HTMLElement, channelId: string) =>
  act(() => {
    dmRow(host, channelId).closest("li")!.dispatchEvent(new MouseEvent("mouseleave"));
  });
const closeButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('[data-testid="dm-close"]');
const rowIds = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="channel-item"][data-channel-id]')].map(
    (el) => el.dataset.channelId
  );
/** 쿼리 응답(에이전트 생존 판정)이 도착해 다시 그려지도록 한 박자 기다린다. */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
/** requestAnimationFrame 한 번(캐럿 인계가 다음 프레임에 도착한다). */
const nextFrame = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

describe("DM 호버 X (#3963)", () => {
  it("DM 행에만 선다: 호버하면 X, 채널 행은 호버해도 없다", async () => {
    const host = await mount();
    expect(closeButton(host)).toBeNull();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).not.toBeNull();
    leaveRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
    // 채널 행: 같은 호버에도 X 가 없다 — 채널을 치우는 문은 「나가기」(메뉴)다.
    act(() => {
      dmRow(host, CH_GENERAL).closest("li")!.dispatchEvent(new MouseEvent("mouseenter"));
    });
    expect(closeButton(host)).toBeNull();
  });

  it("X 는 상대의 이름을 말하고 탭 정거장이 아니다", async () => {
    const host = await mount();
    enterRow(host, DM_ID(1));
    const x = closeButton(host)!;
    expect(x.getAttribute("aria-label")).toBe("이도현, 대화 닫기");
    expect(x.tabIndex).toBe(-1);
    // 링크 안의 버튼이 아니다: 앵커 안의 상호작용 콘텐츠는 클릭이 어느 쪽인지 브라우저마다 다르다.
    expect(dmRow(host, DM_ID(1)).contains(x)).toBe(false);
    // 같은 행 메뉴 트리거 상자 안에 선다: X 위의 우클릭도 행 메뉴를 연다.
    expect(x.closest("[data-row-menu-trigger]")).toBe(
      dmRow(host, DM_ID(1)).closest("[data-row-menu-trigger]")
    );
  });

  it("X 가 선 동안 링크가 알린다: 오른쪽 끝 덩어리를 내리고 그 자리를 비운다(tokens.css)", async () => {
    // 안 읽음이 있는 DM 에는 X 가 서지 않으므로(소유자 결정 2026-10-17) 알약과 X 는 한 행에 함께 서지 않는다.
    // 오른쪽 끝에는 그래도 점·알약·뒤따르는 슬롯(생존 라벨)이 설 수 있어 그 덩어리 하나가 내려간다.
    const host = await mount();
    const link = dmRow(host, DM_ID(3));
    expect(link.hasAttribute("data-row-close")).toBe(false);
    expect(link.querySelector("[data-row-trailing]")).not.toBeNull();
    enterRow(host, DM_ID(3));
    expect(link.hasAttribute("data-row-close")).toBe(true);
    leaveRow(host, DM_ID(3));
    expect(link.hasAttribute("data-row-close")).toBe(false);
  });

  it("DM 아바타는 글리프의 축에 앉는다고 행이 말한다", async () => {
    const host = await mount();
    const kinds = (id: string) =>
      dmRow(host, id).querySelector("[data-row-icon]")?.getAttribute("data-icon-kind");
    expect(kinds(DM_ID(1))).toBe("avatar");
    expect(kinds(CH_GENERAL)).toBeNull();
  });

  it("터치(hover: none)에는 X 가 서지 않는다", async () => {
    touch.hoverNone = true;
    const host = await mount();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
  });
});

describe("DM 닫기는 안 읽음이 없을 때만 (#3963, 소유자 결정 2026-10-17 「안 읽음 있으면 X 숨김」)", () => {
  const menuOpen = () => document.querySelector('[data-testid="channel-row-menu"]') !== null;
  const menuCloseItem = () => document.querySelector('[data-testid="channel-row-close-dm"]');
  const rightClickRow = (host: HTMLElement, channelId: string) =>
    act(() => {
      dmRow(host, channelId).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 40 })
      );
    });
  const flush = () =>
    act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  const escapeMenu = async () => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
  };

  beforeAll(() => {
    // Radix 메뉴가 jsdom 에서 열리도록(`SidebarRowContextMenu.test.tsx` 와 같은 대역).
    HTMLElement.prototype.scrollIntoView = () => undefined;
    HTMLElement.prototype.hasPointerCapture = () => false;
    HTMLElement.prototype.setPointerCapture = () => undefined;
    HTMLElement.prototype.releasePointerCapture = () => undefined;
    if (typeof globalThis.ResizeObserver === "undefined") {
      globalThis.ResizeObserver = class ResizeObserver {
        observe() { return undefined; }
        unobserve() { return undefined; }
        disconnect() { return undefined; }
      };
    }
  });

  it("안 읽은 메시지가 있는 DM 은 호버해도 X 가 서지 않는다 — 알약은 그대로다", async () => {
    setReadStates([readState(DM_ID(1), 12, 10)]);
    const host = await mount();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
    expect(dmRow(host, DM_ID(1)).querySelector('[data-testid="unread-count"]')?.textContent).toBe("2");
    // 같은 목록의 읽은 DM 에는 선다: 규칙은 행마다다.
    leaveRow(host, DM_ID(1));
    enterRow(host, DM_ID(2));
    expect(closeButton(host)).not.toBeNull();
  });

  it("멘션이 있으면 X 가 서지 않는다(멘션 포함) — 안 읽음 수가 0 이어도", async () => {
    // 안 읽음 + 멘션
    setReadStates([{ ...readState(DM_ID(1), 12, 10), mentionCount: 1 }]);
    const host = await mount();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
    leaveRow(host, DM_ID(1));
    // 멘션만(수가 0 인 투영도 멘션 알약은 선다)
    setReadStates([{ ...readState(DM_ID(1), 12), mentionCount: 1 }]);
    await rerender();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
  });

  it("읽고 나면(투영의 안 읽음이 0 이 되면) X 가 다시 선다", async () => {
    setReadStates([readState(DM_ID(1), 12, 10)]);
    const host = await mount();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
    leaveRow(host, DM_ID(1));
    // 다 읽었다.
    setReadStates([readState(DM_ID(1), 12, 12)]);
    await rerender();
    expect(dmRow(host, DM_ID(1)).querySelector('[data-testid="unread-count"]')).toBeNull();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).not.toBeNull();
    // 다시 안 읽음이 생기면 사라진다(호버 중이어도).
    setReadStates([readState(DM_ID(1), 13, 12)]);
    await rerender();
    expect(closeButton(host)).toBeNull();
  });

  it("「읽지 않음으로 표시하기」로 안 읽음이 되면(합성 안 읽음) X 는 사라진다", async () => {
    // 서버 unread_count 는 0 인데 마크가 있어 합성 안 읽음이 선다(ADR-0178).
    setReadStates([{ ...readState(DM_ID(1), 12), markedUnreadBeforeSeq: 12 }]);
    const host = await mount();
    enterRow(host, DM_ID(1));
    expect(dmRow(host, DM_ID(1)).querySelector('[data-testid="unread-count"]')).not.toBeNull();
    expect(closeButton(host)).toBeNull();
  });

  it("우클릭 메뉴의 「대화 닫기」도 같은 규칙이다 — 안 읽음이 있으면 항목이 없고 읽은 DM 에는 있다", async () => {
    setReadStates([readState(DM_ID(1), 12, 10), readState(DM_ID(2), 9)]);
    const host = await mount();
    rightClickRow(host, DM_ID(1));
    await flush();
    expect(menuOpen()).toBe(true);
    expect(menuCloseItem()).toBeNull();
    await escapeMenu();
    rightClickRow(host, DM_ID(2));
    await flush();
    expect(menuOpen()).toBe(true);
    expect(menuCloseItem()?.textContent).toContain("대화 닫기");
  });

  it("지금 열려 있는 DM 은 읽고 있는 것이라 안 읽음이 있던 DM 이어도 닫을 수 있다", async () => {
    setReadStates([readState(DM_ID(1), 12, 10)]);
    const host = await mount(`/c/${DM_ID(1)}`);
    expect(dmRow(host, DM_ID(1)).querySelector('[data-testid="unread-count"]')).toBeNull();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).not.toBeNull();
  });

  it("읽음 투영이 오는 중이거나 못 읽었으면 안 읽음이 없어도 X 가 없다(기준 seq 가 없다)", async () => {
    readStatesQuery.isPending = true;
    readStatesQuery.data = undefined;
    // 마지막 투영의 사본이 있어야 행이 선다(사본도 원장도 없으면 판정을 미룬다, D8).
    localStorage.setItem(DM_CLOSURE_CACHE_KEY, JSON.stringify({ [WS]: { [DM_ID(2)]: [null, 0, 0, 0] } }));
    const host = await mount();
    enterRow(host, DM_ID(2));
    expect(closeButton(host)).toBeNull();
  });

  it("닫기는 읽음 커서를 건드리지 않는다: 닫을 때 서버에 쓰는 요청(PUT·POST·DELETE)이 나가지 않는다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      setReadStates([readState(DM_ID(2), 9)]);
      const host = await mount();
      await flush();
      const writes = () =>
        fetchSpy.mock.calls.filter(([, init]) => {
          const method = (init as RequestInit | undefined)?.method?.toUpperCase();
          return method !== undefined && method !== "GET";
        });
      const before = writes().length;
      enterRow(host, DM_ID(2));
      act(() => closeButton(host)!.click());
      await flush();
      expect(rowIds(host)).not.toContain(DM_ID(2));
      expect(writes().length).toBe(before);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("DM 닫기: 사라지고, 돌아온다 (#3963)", () => {
  it("X 를 누르면 그 DM 만 사라진다. 원장에는 닫을 때의 최신 seq 가 남는다", async () => {
    setReadStates([readState(DM_ID(1), 4), readState(DM_ID(2), 9)]);
    const host = await mount();
    expect(rowIds(host)).toContain(DM_ID(2));
    enterRow(host, DM_ID(2));
    act(() => closeButton(host)!.click());
    expect(rowIds(host)).not.toContain(DM_ID(2));
    expect(rowIds(host)).toEqual(expect.arrayContaining([DM_ID(1), DM_ID(3), DM_ID(4)]));
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(2))).toBe(9);
    // 기기 로컬이다: 새로고침(저장소에서 다시 읽기)해도 닫힌 채다.
    act(() => reloadClosedDmsForTest(localStorage));
    await rerender();
    expect(rowIds(host)).not.toContain(DM_ID(2));
  });

  it("새 메시지가 오면(latestSeq 증가) 다시 나타난다", async () => {
    setReadStates([readState(DM_ID(2), 9)]);
    const host = await mount();
    enterRow(host, DM_ID(2));
    act(() => closeButton(host)!.click());
    expect(rowIds(host)).not.toContain(DM_ID(2));
    // 같은 투영을 다시 받아도(재조회) 숨은 채다.
    setReadStates([readState(DM_ID(2), 9)]);
    await rerender();
    expect(rowIds(host)).not.toContain(DM_ID(2));
    // 새 메시지 한 건.
    setReadStates([readState(DM_ID(2), 10, 9)]);
    await rerender();
    await flush();
    expect(rowIds(host)).toContain(DM_ID(2));
    // 다시 나타날 때는 안 읽음 알약과 함께다.
    expect(
      dmRow(host, DM_ID(2)).querySelector('[data-testid="unread-count"]')?.textContent
    ).toBe("1");
  });

  it("투영이 오는 중이면 닫은 DM 은 숨은 채이고, 못 읽었으면 보인다", async () => {
    closeDmOnDevice(WS, DM_ID(2), 9);
    readStatesQuery.isPending = true;
    readStatesQuery.data = undefined;
    const host = await mount();
    expect(rowIds(host)).not.toContain(DM_ID(2));
    // 한 번도 못 읽었다: 새 메시지가 왔는지 모르는 채 숨기는 쪽이 최악이다.
    readStatesQuery.isPending = false;
    readStatesQuery.isError = true;
    await rerender();
    expect(rowIds(host)).toContain(DM_ID(2));
  });

  it("지금 열려 있는 DM 은 닫아 둔 것이어도 보이고, 그 주소로 들어가면 다시 열린다", async () => {
    closeDmOnDevice(WS, DM_ID(3), 7);
    setReadStates([readState(DM_ID(3), 7)]);
    const host = await mount(`/c/${DM_ID(3)}`);
    expect(rowIds(host)).toContain(DM_ID(3));
    // 열린 순간 원장에서 지운다: 다른 곳으로 옮겨 가도 도로 사라지지 않는다.
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(3))).toBeUndefined();
  });

  it("열려 있는 DM 을 X 로 닫으면 `/` 로 착지하고 그 DM 은 사라진다", async () => {
    setReadStates([readState(DM_ID(2), 9)]);
    const host = await mount(`/c/${DM_ID(2)}`);
    expect(rowIds(host)).toContain(DM_ID(2));
    enterRow(host, DM_ID(2));
    act(() => closeButton(host)!.click());
    await nextFrame();
    // 보고 있던 대화가 사라진 자리에 머물지 않는다. 같은 렌더에서 원장 정리가 닫기를 되돌리지도 않는다.
    expect(rowIds(host)).not.toContain(DM_ID(2));
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(2))).toBe(9);
  });

  it("닫은 뒤 캐럿은 이웃 행으로 간다: 다음 행, 마지막이면 이전 행", async () => {
    const host = await mount();
    enterRow(host, DM_ID(2));
    act(() => closeButton(host)!.click());
    await nextFrame();
    expect(document.activeElement).toBe(dmRow(host, DM_ID(3)));

    // 목록의 마지막 DM 을 닫으면 이전 행으로.
    const last = rowIds(host).filter((id) => id !== undefined).slice(-1)[0]!;
    enterRow(host, last);
    act(() => closeButton(host)!.click());
    await nextFrame();
    const remaining = rowIds(host).filter((id) => id !== undefined);
    expect(document.activeElement).toBe(dmRow(host, remaining[remaining.length - 1]!));
  });

  it("모든 DM 을 닫으면 빈 구획은 「대화가 없다」가 아니라 닫은 대화를 말한다", async () => {
    channelsQuery.groups = { channels: [general], dms: [dms[0]] };
    channelsQuery.data = [general, dms[0]];
    const host = await mount();
    expect(host.querySelector('[data-testid="dm-section-empty"]')).toBeNull();
    enterRow(host, DM_ID(1));
    act(() => closeButton(host)!.click());
    const empty = host.querySelector('[data-testid="dm-section-empty"]');
    if (empty === null) console.log("DBG", host.querySelector('[data-testid="sidebar-section-dms"]')?.outerHTML.slice(0, 1500));
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("닫은 대화는 새 메시지가 오면 다시 나타납니다");
    expect(empty!.textContent).not.toContain("아직 대화가 없습니다");
    // 빈 상태는 한 줄 카피와 액션 하나다: 옛 문장의 행동(⌘⇧K로 시작하세요)이 남아 있다.
    expect(empty!.textContent).toContain("⌘⇧K로 시작하세요");
  });

  it("DM 이 원래 하나도 없으면 예전 문장 그대로다", async () => {
    channelsQuery.groups = { channels: [general], dms: [] };
    channelsQuery.data = [general];
    const host = await mount();
    expect(host.querySelector('[data-testid="dm-section-empty"]')?.textContent).toContain(
      "아직 대화가 없습니다"
    );
  });

  it("닫는다고 대화가 목록에서 지워지지는 않는다: 닫은 DM 도 채널 목록 쿼리에는 그대로다", async () => {
    const host = await mount();
    enterRow(host, DM_ID(2));
    act(() => closeButton(host)!.click());
    // 에이전트 구독·⌘K 목록이 읽는 원본(`channelsQuery.groups.dms`)은 건드리지 않는다.
    expect(channelsQuery.groups.dms.map((c) => c.id)).toContain(DM_ID(2));
  });
});

describe("닫기는 준비된 기준 위에서만 내민다 (design-review R1 M1)", () => {
  it("읽음 투영이 오는 중이면 호버해도 X 가 없고, 준비되면 선다", async () => {
    // 닫을 때 서버의 최신 seq 를 워터마크로 적는다. 투영이 오기 전에 0 으로 적으면 도착하는 순간
    // 「최신 > 0」이 되어 방금 닫은 대화가 되살아났다(실측 4.37초). 기준이 없으면 문을 열지 않는다.
    readStatesQuery.isPending = true;
    readStatesQuery.data = undefined;
    localStorage.setItem(DM_CLOSURE_CACHE_KEY, JSON.stringify({ [WS]: { [DM_ID(1)]: [null, 0, 0, 0] } }));
    const host = await mount();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
    leaveRow(host, DM_ID(1));
    readStatesQuery.isPending = false;
    setReadStates([readState(DM_ID(1), 5)]);
    await rerender();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).not.toBeNull();
  });

  it("읽음 투영을 한 번도 못 읽었으면 X 가 없다 — 닫기가 영영 붙지 않는 문을 내밀지 않는다", async () => {
    readStatesQuery.isError = true;
    readStatesQuery.data = undefined;
    const host = await mount();
    enterRow(host, DM_ID(1));
    expect(closeButton(host)).toBeNull();
  });
});

describe("채널이 없는 멤버의 첫 DM (design-review R1 H1)", () => {
  beforeEach(() => {
    channelsQuery.groups = { channels: [], dms };
    channelsQuery.data = [...dms];
  });

  it("`/` 가 첫 DM 을 열어 주는 상태에서 그 DM 을 X 로 닫으면 정말 사라진다", async () => {
    // 첫 판은 `channels[0] ?? dms[0]` 폴백 때문에 닫은 DM 이 「열려 있음」으로 남아, 누른 결과가 화면에
    // 보이지 않았다(보이는 컨트롤의 무반응).
    setReadStates([readState(DM_ID(1), 12)]);
    const host = await mount("/");
    expect(rowIds(host)).toContain(DM_ID(1));
    enterRow(host, DM_ID(1));
    act(() => closeButton(host)!.click());
    expect(rowIds(host)).not.toContain(DM_ID(1));
    expect(rowIds(host)).toContain(DM_ID(2));
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(1))).toBe(12);
  });

  it("새 메시지가 오면 그 DM 은 다시 나타난다", async () => {
    setReadStates([readState(DM_ID(1), 12)]);
    const host = await mount("/");
    enterRow(host, DM_ID(1));
    act(() => closeButton(host)!.click());
    expect(rowIds(host)).not.toContain(DM_ID(1));
    setReadStates([readState(DM_ID(1), 13, 12)]);
    await rerender();
    await flush();
    expect(rowIds(host)).toContain(DM_ID(1));
  });

  it("DM 이 하나뿐이어도 닫으면 사라지고, 구획은 닫은 대화를 말한다", async () => {
    channelsQuery.groups = { channels: [], dms: [dms[0]] };
    channelsQuery.data = [dms[0]];
    setReadStates([readState(DM_ID(1), 3)]);
    const host = await mount("/");
    expect(rowIds(host)).toEqual([DM_ID(1)]);
    enterRow(host, DM_ID(1));
    act(() => closeButton(host)!.click());
    expect(rowIds(host)).toEqual([]);
    expect(host.querySelector('[data-testid="dm-section-empty"]')?.textContent).toContain(
      "닫은 대화는 새 메시지가 오면 다시 나타납니다"
    );
  });
});

// =============================================================================
// 닫은 DM 은 「사람이 읽을 새 메시지」가 올 때만 돌아온다 (#4142)
// =============================================================================

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 그 DM 의 「닫은 뒤 메시지 읽기」 응답을 붙든다(#4273). 돌려준 함수를 부르면 붙든 읽기가 끝난다. */
function holdRevivalRead(channelId: string): () => void {
  let open: () => void = () => undefined;
  revival.holds.set(
    channelId.toLowerCase(),
    new Promise<void>((resolve) => {
      open = resolve;
    })
  );
  return open;
}

describe("닫은 DM 은 사람이 읽을 새 메시지가 올 때만 돌아온다 (#4142)", () => {
  const WORK_CARD = { type: "text", props: { kind: "work_session" } };

  async function closeDm2(): Promise<HTMLElement> {
    setReadStates([readState(DM_ID(2), 9)]);
    const host = await mount();
    enterRow(host, DM_ID(2));
    act(() => closeButton(host)!.click());
    expect(rowIds(host)).not.toContain(DM_ID(2));
    return host;
  }

  it("seq 가 올랐어도 새 메시지가 기계 메시지(system·work_session·tool_*)뿐이면 숨은 채다", async () => {
    revival.pages.set(DM_ID(2), [{ type: "system" }, WORK_CARD, { type: "tool_result" }]);
    const host = await closeDm2();
    setReadStates([readState(DM_ID(2), 12, 9)]);
    await rerender();
    await flush();
    expect(rowIds(host)).not.toContain(DM_ID(2));
    // 닫은 뒤(9)부터를 읽었다(되살림의 크기 50).
    expect(revival.calls).toContainEqual({ channelId: DM_ID(2), after: 9, limit: 50 });
  });

  it("읽는 동안에는 깜빡이며 나타나지 않는다(숨은 채 기다린다)", async () => {
    const host = await closeDm2();
    // 읽기를 시험이 붙든다. 예전에는 응답이 마이크로태스크로 곧장 끝나서, `await rerender()` 가 돌아온 시점에 「아직 읽는 중」인지가
    // react-query 알림 타이머(setTimeout 0)와 `act` 복귀 중 누가 먼저 도는지에 달려 있었다(#4273): 부하에서 타이머가 먼저면 행이 이미 돌아와 있었다.
    const finishRead = holdRevivalRead(DM_ID(2));
    setReadStates([readState(DM_ID(2), 10, 9)]);
    await rerender();
    await flush();
    // 읽기는 나갔고(닫은 뒤 9부터) 끝나지 않았다. 이벤트 루프가 몇 바퀴를 돌았든 숨은 채다.
    // 요청이 나갔다는 단정이 「읽는 중이라서 숨었다」를 「읽기 후보가 아니라서 숨었다」와 가른다.
    expect(revival.calls).toContainEqual({ channelId: DM_ID(2), after: 9, limit: 50 });
    expect(rowIds(host)).not.toContain(DM_ID(2));
    finishRead();
    await flush();
    // 기본 대역은 사람이 쓴 글 한 건: 이제 돌아온다.
    expect(rowIds(host)).toContain(DM_ID(2));
  });

  it("기계 메시지 뒤에 사람이 쓴 글이 오면 돌아온다", async () => {
    revival.pages.set(DM_ID(2), [WORK_CARD]);
    const host = await closeDm2();
    setReadStates([readState(DM_ID(2), 10, 9)]);
    await rerender();
    await flush();
    expect(rowIds(host)).not.toContain(DM_ID(2));
    revival.pages.set(DM_ID(2), [WORK_CARD, { type: "text" }]);
    setReadStates([readState(DM_ID(2), 11, 9)]);
    await rerender();
    await flush();
    expect(rowIds(host)).toContain(DM_ID(2));
  });

  it("같은 seq 를 다시 받아도(30초 재조회) 다시 읽지 않는다", async () => {
    revival.pages.set(DM_ID(2), [WORK_CARD]);
    const host = await closeDm2();
    setReadStates([readState(DM_ID(2), 10, 9)]);
    await rerender();
    await flush();
    const first = revival.calls.length;
    setReadStates([readState(DM_ID(2), 10, 9)]);
    await rerender();
    await flush();
    expect(revival.calls.length).toBe(first);
    expect(rowIds(host)).not.toContain(DM_ID(2));
  });

  it("읽기가 실패하면 돌아온다 — 새 메시지가 왔는지 모를 때 숨기는 쪽이 최악이다", async () => {
    revival.pages.set(DM_ID(2), "fail");
    const host = await closeDm2();
    setReadStates([readState(DM_ID(2), 10, 9)]);
    await rerender();
    await flush();
    // 한 번 더 읽어 보는 동안은 숨은 채다.
    expect(rowIds(host)).not.toContain(DM_ID(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, REVIVAL_RETRY_DELAY_MS + 100));
    });
    await flush();
    expect(rowIds(host)).toContain(DM_ID(2));
  });

});

describe("투영을 못 읽은 동안 `/` 폴백이 닫은 DM 의 원장을 지우지 않는다 (#4142)", () => {
  beforeEach(() => {
    channelsQuery.groups = { channels: [], dms };
    channelsQuery.data = [...dms];
  });

  it("일시 오류로 닫은 DM 이 폴백이 열어도 원장 항목은 남고, 오류가 풀리면 다시 숨는다", async () => {
    closeDmOnDevice(WS, DM_ID(1), 12);
    readStatesQuery.isError = true;
    readStatesQuery.data = undefined;
    readStatesQuery.byChannel = new Map();
    const host = await mount("/");
    // 못 읽었으니 보인다(원장 규칙).
    expect(rowIds(host)).toContain(DM_ID(1));
    // 사람이 연 것이 아니므로 원장은 그대로다. 예전에는 여기서 지워졌다.
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(1))).toBe(12);
    readStatesQuery.isError = false;
    setReadStates([readState(DM_ID(1), 12)]);
    await rerender();
    expect(rowIds(host)).not.toContain(DM_ID(1));
  });
});

// =============================================================================
// DM 행의 상태 점 (#3964): 글자 라벨 대신 아바타 모서리의 점
// =============================================================================

describe("DM 행의 상태 점 (#3964)", () => {
  const dotOf = (host: HTMLElement, id: string) =>
    dmRow(host, id).querySelector<HTMLElement>('[data-testid="dm-peer-dot"]');
  const AGENT_DM = DM_ID(4);

  it("사이드바 행에는 생존 글자 라벨이 없다 — 「꺼짐」은 점이 대신 말한다", async () => {
    liveness.byAgent.set(PEER_AGENT, "inactive");
    const host = await mount();
    await settle();
    expect(host.querySelector('[data-testid="agent-liveness"]')).toBeNull();
    // 눈에 보이는 글자에 「꺼짐」이 없다(숨은 글 `sr-only` 는 접근 가능한 이름의 몫이다).
    const visible = [...dmRow(host, AGENT_DM).querySelectorAll("*")]
      .filter((el) => !el.closest(".sr-only"))
      .map((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""))
      .join("");
    expect(visible).not.toContain("꺼짐");
    expect(visible).not.toContain("연결이 꺼져");
  });

  it("에이전트: 생존 판정이 점이 된다 — 응답함·살아 있음은 채운 초록, 꺼짐은 속이 빈 회색 고리 (Buzz식, 소유자 결정 2026-10-17)", async () => {
    // 모양이 말한다(낱말이 없는 자리): 채운 초록 = 살아 있음, 속 빈 고리 = 꺼짐. 「살아 있지만 일이 없는」 에이전트와
    // 「꺼진」 에이전트가 한 점이면 점이 질문에 답하지 못한다 (#3964 H1). 응답함과 살아 있음·대기는 낱말이 가른다.
    const cases: Array<[string, string, string[], string[]]> = [
      ["responsive", "ok", ["bg-ok", "border-surface"], ["bg-surface", "bg-ink-muted"]],
      ["alive_idle", "ok", ["bg-ok", "border-surface"], ["bg-surface", "bg-ink-muted"]],
      ["inactive", "muted", ["bg-surface", "border-line-strong"], ["bg-ok", "bg-ink-muted"]],
      ["quiet", "muted", ["bg-surface", "border-line-strong"], ["bg-ok", "bg-ink-muted"]],
    ];
    for (const [state, tone, has, lacks] of cases) {
      liveness.byAgent.set(PEER_AGENT, state);
      const host = await mount();
      await settle();
      const dot = dotOf(host, AGENT_DM)!;
      expect(dot.getAttribute("data-tone"), state).toBe(tone);
      for (const cls of has) expect(dot.className, `${state}: ${cls}`).toContain(cls);
      for (const cls of lacks) expect(dot.className, `${state}: !${cls}`).not.toContain(cls);
      act(() => mountedRoot?.unmount());
      mountedHost?.remove();
    }
  });

  it("툴팁(title)과 행의 숨은 글에 낱말이 있다: 「이름, 연결이 꺼져 있어요」", async () => {
    liveness.byAgent.set(PEER_AGENT, "inactive");
    const host = await mount();
    await settle();
    const avatar = dmRow(host, AGENT_DM).querySelector('[data-testid="dm-avatar"]')!;
    expect(avatar.getAttribute("title")).toContain("연결이 꺼져 있어요");
    // 뜻까지: 이 에이전트의 연결이 꺼져 있다는 서버의 한 문장.
    expect(avatar.getAttribute("title")).toContain("이 에이전트의 연결이 꺼져 있어요");
    const hidden = dmRow(host, AGENT_DM).querySelector(".sr-only");
    expect(hidden?.textContent).toBe(", 연결이 꺼져 있어요");
    expect(dmRow(host, AGENT_DM).textContent).toMatch(/김인턴, 연결이 꺼져 있어요/);
  });

  it("사람: 자리 비움은 주황 채움 점이고, 낱말은 숨은 글에 있다", async () => {
    const host = await mount();
    await settle();
    const dot = dotOf(host, DM_ID(3))!;
    expect(dot.getAttribute("data-tone")).toBe("warn");
    expect(dot.className).toContain("bg-warn");
    expect(dmRow(host, DM_ID(3)).querySelector(".sr-only")?.textContent).toBe(", 자리 비움");
  });

  it("**회색 점은 에이전트에만 선다** — 평범한 사람·나간 멤버에는 점이 없다", async () => {
    liveness.byAgent.set(PEER_AGENT, "inactive");
    showGhostRow();
    const host = await mount();
    await settle();
    for (const id of [DM_ID(1), DM_ID(2), DM_ID(6)]) {
      expect(dotOf(host, id)).toBeNull();
    }
    // 그리고 회색(muted: 속 빈 고리)이 어디 있든 그것은 에이전트 행이다.
    const gray = [...host.querySelectorAll('[data-testid="dm-peer-dot"][data-tone="muted"]')];
    expect(gray).toHaveLength(1);
    expect(gray[0].closest('[data-testid="channel-item"]')?.getAttribute("data-channel-id")).toBe(AGENT_DM);
  });

  it("판정을 아직 모르는 동안은 점이 없다 — 호스트 폴백을 먼저 그려 거짓을 한 번 그리지 않는다", async () => {
    liveness.byAgent.set(PEER_AGENT, "pending");
    const host = await mount();
    await settle();
    expect(dotOf(host, AGENT_DM)).toBeNull();
  });

  it("경고색은 다시 깨울 수 있는 사람(owner/admin)에게만 경고다", async () => {
    liveness.byAgent.set(PEER_AGENT, "woken_not_collected");
    const host = await mount();
    await settle();
    expect(dotOf(host, AGENT_DM)!.getAttribute("data-tone")).toBe("warn");
    act(() => mountedRoot?.unmount());
    mountedHost?.remove();
    const owner = roster[0];
    roster[0] = { ...owner, role: "member" };
    try {
      const again = await mount();
      await settle();
      // 같은 사실이 보는 사람에게는 중립(회색 고리)이다.
      expect(dotOf(again, AGENT_DM)!.getAttribute("data-tone")).toBe("muted");
    } finally {
      roster[0] = owner;
    }
  });

  it("아바타를 알아볼 수 없는 행(나간 멤버)은 점 하나가 아니라 기본 아바타다", async () => {
    showGhostRow();
    const host = await mount();
    await settle();
    const ghost = dmRow(host, DM_ID(6));
    expect(ghost.querySelector('[data-testid="dm-avatar"]')?.getAttribute("data-avatar-kind")).toBe("unknown");
    expect(ghost.querySelector('[data-testid="dm-avatar-default"]')).not.toBeNull();
    // 모를 때 이니셜을 지어내지 않는다(코어 `avatar.ts`).
    expect(ghost.querySelector('[data-testid="dm-avatar"]')?.textContent).toBe("");
  });

  it("채널 행에는 점도 숨은 상태 글도 없다", async () => {
    const host = await mount();
    await settle();
    const row = dmRow(host, CH_GENERAL);
    expect(row.querySelector('[data-testid="dm-peer-dot"]')).toBeNull();
    expect(row.querySelector(".sr-only")).toBeNull();
  });
});

// =============================================================================
// 나간 멤버와의 대화는 안 읽음이 없으면 기본으로 접힌다 (#4252)
// 성재(2026-10-20·22): 「나간 멤버랑 Claude Code X로 계속 제거하는데 왜 계속 뜨냐」.
// 규칙은 코어 `dmHiddenAsGone` 이 갖고(시험: `goneDm.test.ts`), 여기서는 사이드바가 그것을 제대로 배선했는지 잰다.
// =============================================================================

describe("나간 멤버와의 대화 (#4252)", () => {
  const GONE_DM = DM_ID(6);
  const GHOST_B = "00000000-0000-7000-8000-000000000198";
  const GONE_DM_B = DM_ID(7);
  const ghostB = dm(GONE_DM_B, [GHOST_B]);

  it("나간 멤버 DM 은 안 읽음이 없으면 목록에서 빠지고 「⋯ › 닫은 대화」로 간다 - 「나간 멤버와의 대화 N개」 줄은 어디에도 없다 (ADR-0177 D11, AC 12)", async () => {
    const host = await mount();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
    expect(foldLine(host)).toBeNull();
    // 명부에 있는 상대 · 나 혼자 · 에이전트의 DM 은 그대로 있다.
    for (const n of [1, 2, 3, 4, 5]) expect(rowIds(host)).toContain(DM_ID(n));
  });

  it("접힌 나간 멤버가 여럿이면 수를 센다", async () => {
    channelsQuery.groups = { channels: [general], dms: [...dms, ghostB] };
    channelsQuery.data = [general, ...dms, ghostB];
    const host = await mount();
    expect(closedCount(host)).toBe(2);
  });

  it("안 읽은 메시지가 있으면 접히지 않고, 줄도 없다", async () => {
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
    expect(dmRow(host, GONE_DM).querySelector('[data-testid="unread-count"]')).not.toBeNull();
  });

  it("멘션이 있으면 접히지 않는다", async () => {
    setReadStates([{ ...readState(GONE_DM, 5, 5), mentionCount: 1 }]);
    const host = await mount();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
  });

  it("읽으면 다시 접히고, 새 메시지가 오면 다시 보인다", async () => {
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    setReadStates([readState(GONE_DM, 8, 8)]);
    await rerender();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
    setReadStates([readState(GONE_DM, 9, 8)]);
    await rerender();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
  });

  it("지금 열려 있는 나간 멤버 DM 은 접히지 않고, 다른 곳으로 옮겨 가면 접힌다", async () => {
    const host = await mount(`/c/${GONE_DM}`);
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
    act(() => dmRow(host, DM_ID(1)).click());
    await settle();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
  });

  it("명부를 아직 못 받았으면 접지 않는다 — 「불러오는 중」은 나간 멤버가 아니다", async () => {
    rosterPhase.pending = true;
    const host = await mount();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(dmRow(host, GONE_DM).textContent).toContain("불러오는 중");
    expect(closedCount(host)).toBe(0);
    rosterPhase.pending = false;
    await rerender();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
  });

  it("명부 조회가 실패했으면 접지 않고, 이름도 「나간 멤버」라고 거짓말하지 않는다 (「불러오는 중」, 명부를 믿을 수 있는지는 한 함수가 답한다)", async () => {
    rosterPhase.failed = true;
    const host = await mount();
    for (const n of [1, 2, 3, 4, 5, 6]) expect(rowIds(host)).toContain(DM_ID(n));
    expect(closedCount(host)).toBe(0);
    // 이도현·박서연까지 「나간 멤버」로 읽히던 거짓(design-review M2): 명부를 못 받았으면 이름은 아직 모른다.
    expect(host.textContent).not.toContain("나간 멤버");
    expect(dmRow(host, DM_ID(1)).textContent).toContain("불러오는 중");
  });

  it("읽음 투영을 한 번도 못 읽었으면 접지 않는다 — 안 읽은 것이 있는지 모를 때 숨기는 쪽이 최악이다", async () => {
    readStatesQuery.isError = true;
    readStatesQuery.data = undefined;
    const host = await mount();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
  });

  it("읽음 투영이 오는 중이면 접힌 채 기다린다 (도착하는 순간 나타났다 사라지지 않는다)", async () => {
    readStatesQuery.isPending = true;
    readStatesQuery.data = undefined;
    const host = await mount();
    expect(rowIds(host)).not.toContain(GONE_DM);
    // 투영이 오는 동안은 판정을 미룬 채 숨어 있을 뿐이다: 목록(닫은 대화)에는 아직 없다.
    expect(closedCount(host)).toBe(0);
    expect(foldLine(host)).toBeNull();
  });

  it("닫기 원장과 겹쳐도 한 번만 센다: X 로 닫은 나간 멤버 DM 은 「닫은 대화」에 하나로 든다", async () => {
    closeDmOnDevice(WS, GONE_DM, 0);
    const host = await mount();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
    expect(closedAtSeqOf(closedDmsFor(WS), GONE_DM)).toBe(0);
  });

  it("원장에 닫혀 있던 나간 멤버 DM 에 새 안 읽은 메시지가 오면 되살아난다 (접히지도 않는다)", async () => {
    closeDmOnDevice(WS, GONE_DM, 3);
    setReadStates([readState(GONE_DM, 5, 3)]);
    const host = await mount();
    await flush();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
  });

  it("나간 멤버뿐인 구역: 「아직 대화가 없습니다」는 서지 않고 닫은 대화를 말한다 (한 화면이 「없다」와 「있다」를 같이 말하지 않는다)", async () => {
    channelsQuery.groups = { channels: [], dms: [dms[5]] };
    channelsQuery.data = [dms[5]];
    const host = await mount("/c/none");
    expect(host.querySelector('[data-testid="dm-section-empty"]')?.textContent).toContain(
      "닫은 대화는 새 메시지가 오면 다시 나타납니다"
    );
    expect(host.textContent).not.toContain("아직 대화가 없습니다");
    expect(closedCount(host)).toBe(1);
  });

  it("DM 이 하나도 없으면 빈 안내는 예전 그대로다 (접힌 줄이 없으니 모순이 없다)", async () => {
    channelsQuery.groups = { channels: [], dms: [] };
    channelsQuery.data = [];
    const host = await mount("/c/none");
    expect(host.querySelector('[data-testid="dm-section-empty"]')?.textContent).toContain(
      "아직 대화가 없습니다"
    );
    expect(closedCount(host)).toBe(0);
  });

  it("닫은 DM 과 나간 멤버가 함께 있으면 둘 다 「닫은 대화」에 들고 힌트가 한 번 선다", async () => {
    channelsQuery.groups = { channels: [], dms: [dms[0], dms[5]] };
    channelsQuery.data = [dms[0], dms[5]];
    closeDmOnDevice(WS, DM_ID(1), 3);
    setReadStates([readState(DM_ID(1), 3)]);
    const host = await mount("/c/none");
    expect(host.querySelector('[data-testid="dm-section-empty"]')?.textContent).toContain(
      "닫은 대화는 새 메시지가 오면 다시 나타납니다"
    );
    expect(closedCount(host)).toBe(2);
  });

  it("채널이 없을 때 `/` 는 접힌 나간 멤버 DM 을 열지 않고 다음 DM 을 연다", async () => {
    // 열려 있다고 보는 DM 은 안 읽음 알약이 0 으로 접힌다: 접힌 DM 이 폴백이면 이도현 DM 의 알약이 남는다.
    channelsQuery.groups = { channels: [], dms: [dms[5], dms[0]] };
    channelsQuery.data = [dms[5], dms[0]];
    setReadStates([readState(DM_ID(1), 12, 10)]);
    const host = await mount("/");
    expect(rowIds(host)).toEqual([DM_ID(1)]);
    expect(dmRow(host, DM_ID(1)).querySelector('[data-testid="unread-count"]')).toBeNull();
    expect(closedCount(host)).toBe(1);
  });

});

// =============================================================================
// 나간 멤버 DM 의 안 읽음은 **사람이 읽을 것**이어야 보인다 (#4252, 이슈 AC 「안 읽은 사람 메시지가 있으면 보인다」).
// 읽음 투영의 안 읽은 수는 기계 메시지(작업 상태·영수증)도 센다. 안 읽음이 있는 후보만 안 읽은 쪽을 한 번 읽어 가른다
// (`goneUnreadVerdicts.ts`). 판정 자체는 코어 `goneDm.test.ts`, 여기서는 사이드바가 그 판정을 읽는 배선을 잰다.
// =============================================================================

describe("나간 멤버 DM 의 안 읽음은 사람이 읽을 것이어야 보인다 (#4252)", () => {
  const GONE_DM = DM_ID(6);
  const GHOST_B = "00000000-0000-7000-8000-000000000198";
  const GONE_DM_B = DM_ID(7);
  const ghostB = dm(GONE_DM_B, [GHOST_B]);
  /** 기계 메시지뿐인 쪽: 시스템 줄과 작업 세션 상태 카드. */
  const AMBIENT = [{ type: "system" }, { type: "text", props: { kind: "work_session" } }];
  const callsFor = (channelId: string) => revival.calls.filter((call) => call.channelId === channelId);
  const waitRetry = () =>
    act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, GONE_UNREAD_RETRY_DELAY_MS + 120));
    });

  it("안 읽음이 기계 메시지뿐이면 접힌다: 끈 에이전트의 DM 이 작업 상태 줄 때문에 남지 않는다", async () => {
    revival.pages.set(GONE_DM, AMBIENT);
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
    // 마지막으로 읽은 seq 뒤를 한 번만 읽는다.
    expect(callsFor(GONE_DM)).toEqual([{ channelId: GONE_DM, after: 5, limit: 200 }]);
  });

  it("사람이 읽을 메시지가 섞여 있으면 보인다", async () => {
    revival.pages.set(GONE_DM, [{ type: "system" }, { type: "text" }]);
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
  });

  it("안 읽은 기계 메시지가 50~199건이어도 접힌다: 서버가 한 쪽에 줄 수 있는 최대(200건)까지 읽는다 (design-review M-A)", async () => {
    for (const n of [50, 120, 199]) {
      revival.pages.set(GONE_DM, Array.from({ length: n }, () => ({ type: "system" })));
      revival.calls.length = 0;
      setReadStates([readState(GONE_DM, 5 + n, 5)]);
      const host = await mount();
      await settle();
      expect({ n, shown: rowIds(host).includes(GONE_DM) }).toEqual({ n, shown: false });
      expect(closedCount(host)).toBe(1);
      expect(callsFor(GONE_DM)).toEqual([{ channelId: GONE_DM, after: 5, limit: 200 }]);
      act(() => mountedRoot?.unmount());
      mountedRoot = null;
      mountedHost?.remove();
      mountedHost = null;
    }
  });

  it("쪽이 가득 차면(200건이 다 기계 메시지) 뒤를 모르므로 보인다", async () => {
    revival.pages.set(GONE_DM, Array.from({ length: 200 }, () => ({ type: "system" })));
    setReadStates([readState(GONE_DM, 250, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
  });

  it("판정이 오는 중이면 접힌 채다 (읽는 중에 깜빡이며 나타나지 않는다)", async () => {
    revival.pages.set(GONE_DM, "pending");
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
  });

  it("닫은 뒤 사람 글로 되살아나 읽은 DM 에 기계 메시지만 새로 오면 접힌다: 원장 항목이 남아 있어도 후보에서 빼지 않는다 (design-review 3차 재확인 High)", async () => {
    // 이 기기에서 seq 3 에 닫았다. 사람 글(seq 5)이 와서 되살아났고, 다른 기기에서 읽었다(5/5). 그 뒤 기계 메시지가 새로 온다(6~8).
    // 되살림 판정은 닫을 때(3) 뒤를 읽어 사람 글(5)을 계속 보므로 원장 항목이 남아 있는 동안은 읽은 뒤에도 되살림이 유지된다.
    const HUMAN = { type: "text" };
    revival.pages.set(GONE_DM, (after) => ((after ?? 0) >= 5 ? AMBIENT : [{ type: "system" }, HUMAN]));
    closeDmOnDevice(WS, GONE_DM, 3);
    setReadStates([readState(GONE_DM, 5, 3)]);
    const host = await mount();
    await settle();
    await flush();
    // (b1) 사람 글이 와서 되살아났다: 안 읽은 사람 글이라 보인다.
    expect(rowIds(host)).toContain(GONE_DM);
    // (b2) 읽었다: 되살림은 유지되고(원장 항목이 남아 있다) 안 읽음이 없는 나간 멤버 DM 이라 접힌다.
    setReadStates([readState(GONE_DM, 5, 5)]);
    await rerender();
    await settle();
    await flush();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
    // (c) 기계 메시지 세 건이 새로 온다(6~8): 안 읽은 사람 글이 없으니 접힌 채여야 한다.
    revival.calls.length = 0;
    setReadStates([readState(GONE_DM, 8, 5)]);
    await rerender();
    await settle();
    await flush();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
    // 마지막으로 읽은 seq(5) 뒤를 이 훅이 읽었다(되살림은 닫을 때 3 뒤를 읽는다).
    expect(callsFor(GONE_DM)).toContainEqual({ channelId: GONE_DM, after: 5, limit: 200 });
    // 새 쪽에 사람 글이 오면 도로 보인다.
    revival.pages.set(GONE_DM, (after) => ((after ?? 0) >= 5 ? [{ type: "system" }, HUMAN] : [{ type: "system" }, HUMAN]));
    setReadStates([readState(GONE_DM, 9, 5)]);
    await rerender();
    await settle();
    await flush();
    expect(rowIds(host)).toContain(GONE_DM);
  });

  it("X 로 닫아 지금 숨은 나간 멤버 DM 은 후보가 아니다: 되살림 판정이 읽은 같은 쪽을 한 번 더 읽지 않는다 (design-review Low)", async () => {
    // 닫을 때의 seq(3) 뒤로 기계 메시지만 쌓였다: 되살림은 닫은 뒤(3)부터를 한 번 읽어 숨은 채로 둔다.
    revival.pages.set(GONE_DM, AMBIENT);
    closeDmOnDevice(WS, GONE_DM, 3);
    setReadStates([readState(GONE_DM, 8, 3)]);
    const host = await mount();
    await settle();
    await flush();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
    // 같은 URL(after=3)이 두 번 나가지 않는다: 되살림의 한 번(limit 50)뿐이다.
    expect(callsFor(GONE_DM)).toEqual([{ channelId: GONE_DM, after: 3, limit: 50 }]);
  });

  it("메시지를 못 읽었으면 보인다 (안 읽은 것이 사람이 읽을 것인지 모를 때 숨기는 쪽이 최악이다)", async () => {
    revival.pages.set(GONE_DM, "fail");
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await waitRetry();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
  });

  it("메시지를 읽지 않는 DM: 멘션 · 사람이 직접 한 「여기부터 안 읽음」 · 안 읽음이 없는 DM (멘션과 표시는 항상 보인다)", async () => {
    channelsQuery.groups = { channels: [general], dms: [...dms, ghostB] };
    channelsQuery.data = [general, ...dms, ghostB];
    revival.pages.set(GONE_DM, AMBIENT);
    revival.pages.set(GONE_DM_B, AMBIENT);
    setReadStates([
      { ...readState(GONE_DM, 5, 5), mentionCount: 1 },
      { ...readState(GONE_DM_B, 7, 7), markedUnreadBeforeSeq: 4 },
    ]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(rowIds(host)).toContain(GONE_DM_B);
    expect(closedCount(host)).toBe(0);
    expect(callsFor(GONE_DM)).toEqual([]);
    expect(callsFor(GONE_DM_B)).toEqual([]);
  });

  it("안 읽음이 없는 나간 멤버 DM 이나 상대가 있는 DM 은 메시지를 읽지 않는다", async () => {
    setReadStates([readState(GONE_DM, 5, 5), readState(DM_ID(1), 9, 4)]);
    const host = await mount();
    await settle();
    expect(closedCount(host)).toBe(1);
    expect(revival.calls).toEqual([]);
  });

  it("새 메시지가 오는 동안 이전 판정을 유지한다: 사람이 읽을 안 읽음으로 보이던 DM 이 잠깐 접혔다 돌아오지 않는다", async () => {
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    // 새 메시지: 안 읽음 범위가 바뀌어 새 쪽을 읽는다(아직 안 온다).
    revival.pages.set(GONE_DM, "pending");
    setReadStates([readState(GONE_DM, 9, 5)]);
    await rerender();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    expect(closedCount(host)).toBe(0);
    expect(callsFor(GONE_DM).map((call) => call.after)).toEqual([5, 5]);
  });

  it("기계 메시지뿐이라 접힌 DM 에 새 메시지가 오면 새 쪽이 올 때까지 접힌 채고, 사람이 읽을 글이 오면 보인다", async () => {
    revival.pages.set(GONE_DM, AMBIENT);
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).not.toContain(GONE_DM);
    revival.pages.set(GONE_DM, "pending");
    setReadStates([readState(GONE_DM, 9, 5)]);
    await rerender();
    await settle();
    expect(rowIds(host)).not.toContain(GONE_DM);
    revival.pages.set(GONE_DM, [{ type: "system" }, { type: "text" }]);
    setReadStates([readState(GONE_DM, 10, 5)]);
    await rerender();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
  });

  it("다 읽어 후보에서 빠지면 판정을 잊는다: 나중에 온 새 안 읽음은 새로 가른다", async () => {
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    setReadStates([readState(GONE_DM, 8, 8)]);
    await rerender();
    expect(rowIds(host)).not.toContain(GONE_DM);
    // 새 안 읽음이 왔는데 새 쪽이 안 온다: 옛 「사람이 읽을 것」 판정이 아니라 오는 중으로 접힌 채다.
    revival.pages.set(GONE_DM, "pending");
    setReadStates([readState(GONE_DM, 9, 8)]);
    await rerender();
    await settle();
    expect(rowIds(host)).not.toContain(GONE_DM);
  });

  it("보이게 된 DM 을 읽으면 다시 접힌다", async () => {
    setReadStates([readState(GONE_DM, 8, 5)]);
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(GONE_DM);
    setReadStates([readState(GONE_DM, 8, 8)]);
    await rerender();
    expect(rowIds(host)).not.toContain(GONE_DM);
    expect(closedCount(host)).toBe(1);
  });
});

// =============================================================================
// 줄이 눌린 채 사라질 때의 캐럿 (#4252, design-review H1) · 명부·읽음 투영 실패의 이유 (H2·M1)
// =============================================================================

describe("나간 멤버와의 대화 줄: 캐럿과 실패의 이유 (#4252)", () => {
  const GONE_DM = DM_ID(6);

  it("명부 조회가 실패하면 DM 구역이 이유와 다시 시도를 말한다 (design-review H2)", async () => {
    rosterPhase.failed = true;
    const host = await mount();
    const banner = host.querySelector<HTMLElement>('[data-testid="roster-error"]');
    expect(banner?.textContent).toContain("멤버 목록을 불러오지 못해 대화 이름을 알 수 없어요.");
    const retry = banner!.querySelector<HTMLButtonElement>("button")!;
    expect(retry.textContent).toBe("다시 시도");
    act(() => retry.click());
    expect(refetchers.roster).toHaveBeenCalledTimes(1);
    // 명부가 오면 사라진다.
    rosterPhase.failed = false;
    await rerender();
    expect(host.querySelector('[data-testid="roster-error"]')).toBeNull();
  });

  it("명부가 오는 중일 때는 실패했다고 말하지 않는다 (아직 실패가 아니다)", async () => {
    rosterPhase.pending = true;
    const host = await mount();
    expect(host.querySelector('[data-testid="roster-error"]')).toBeNull();
  });

  it("명부 실패라도 이름을 모르는 DM 이 하나도 없으면(나 혼자의 DM 뿐) 말하지 않는다", async () => {
    rosterPhase.failed = true;
    channelsQuery.groups = { channels: [general], dms: [dms[4]] };
    channelsQuery.data = [general, dms[4]];
    const host = await mount();
    expect(host.querySelector('[data-testid="roster-error"]')).toBeNull();
  });

  it("읽음 투영을 한 번도 못 읽은 채 실패하면 나간 멤버와의 대화를 접지 못했다는 이유와 다시 시도를 말한다 (design-review M1)", async () => {
    readStatesQuery.isError = true;
    readStatesQuery.data = undefined;
    const host = await mount();
    const notice = host.querySelector<HTMLElement>('[data-testid="read-state-error"]');
    expect(notice?.textContent).toContain("안 읽음 표시를 불러오지 못해 나간 멤버와의 대화를 숨기지 못했어요.");
    expect(rowIds(host)).toContain(GONE_DM);
    act(() => notice!.querySelector<HTMLButtonElement>("button")!.click());
    expect(refetchers.read).toHaveBeenCalledTimes(1);
  });

  it("읽음 투영 실패라도 나간 멤버 DM 이 없으면 말하지 않는다", async () => {
    readStatesQuery.isError = true;
    readStatesQuery.data = undefined;
    channelsQuery.groups = { channels: [general], dms: dms.slice(0, 5) };
    channelsQuery.data = [general, ...dms.slice(0, 5)];
    const host = await mount();
    expect(host.querySelector('[data-testid="read-state-error"]')).toBeNull();
  });

  it("명부 실패와 읽음 실패가 겹치면 이름 문장 하나만 말한다 (한 번에 하나)", async () => {
    rosterPhase.failed = true;
    readStatesQuery.isError = true;
    readStatesQuery.data = undefined;
    const host = await mount();
    expect(host.querySelector('[data-testid="roster-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="read-state-error"]')).toBeNull();
  });
});


// =============================================================================
// DM 닫기를 서버 상태로 (ADR-0177 증보 D6~D12, #4228). 서버가 읽음 투영에 `latestReadableSeq`·`closedAtSeq` 를 실으면 이 갈래다.
// =============================================================================

/** 새 서버의 읽음 투영 행: 두 필드를 싣는다. `closedAt` 이 `null` 이면 「안 닫았다」, 숫자면 그 seq 에서 닫았다. */
function serverRow(
  channelId: string,
  patch: {
    latestSeq?: number;
    lastReadSeq?: number;
    readable?: number;
    closedAt?: number | null;
    mentionCount?: number;
  } = {}
): ReadState {
  const latestSeq = patch.latestSeq ?? 10;
  const lastReadSeq = patch.lastReadSeq ?? latestSeq;
  return {
    ...readState(channelId, latestSeq, lastReadSeq),
    mentionCount: patch.mentionCount ?? 0,
    latestReadableSeq: patch.readable ?? latestSeq,
    closedAtSeq: patch.closedAt === undefined ? null : patch.closedAt,
  };
}

/** DM 1~5 는 안 닫은 행, 6(나간 상대)도 한 행으로 둔다. 시험이 한 칸씩 바꾼다. */
function serverRows(patch: Partial<Record<number, Parameters<typeof serverRow>[1]>> = {}): ReadState[] {
  return [1, 2, 3, 4, 5, 6].map((n) => serverRow(DM_ID(n), patch[n]));
}

describe("DM 닫기 · 서버 갈래 (#4228)", () => {
  it("서버가 닫았다고 말한 DM 은 목록에서 빠지고 「닫은 대화」에 든다 - 메시지를 다시 읽지 않는다", async () => {
    // seq 만 25 로 올랐고(기계 메시지) 읽을 seq 는 닫을 때 그대로다: 되살림 판정이 메시지를 읽지 않아도 숨은 채다.
    setReadStates(serverRows({ 2: { latestSeq: 25, readable: 10, closedAt: 10, lastReadSeq: 4 } }));
    const host = await mount();
    await settle();
    expect(rowIds(host)).not.toContain(DM_ID(2));
    for (const n of [1, 3, 4, 5]) expect(rowIds(host)).toContain(DM_ID(n));
    expect(closedCount(host)).toBe(2); // 내가 닫은 DM 2 + 나간 상대 DM 6
    expect(revival.calls).toEqual([]);
  });

  it("닫은 뒤 읽을 메시지가 오면 돌아온다(8번)", async () => {
    setReadStates(serverRows({ 2: { latestSeq: 12, readable: 12, closedAt: 10, lastReadSeq: 10 } }));
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(DM_ID(2));
  });

  it("나간 상대의 DM 은 안 읽은 것이 없으면 빠지고, 안 읽은 읽을 메시지가 있으면 보인다 - 메시지를 읽어 가르지 않는다", async () => {
    setReadStates(serverRows({ 6: { latestSeq: 14, readable: 12, lastReadSeq: 10 } }));
    const host = await mount();
    await settle();
    expect(rowIds(host)).toContain(DM_ID(6));
    expect(closedCount(host)).toBe(0);
    expect(revival.calls).toEqual([]);
  });

  it("호버 X 는 서버에 PUT 으로 쓴다: seenSeq 는 화면이 본 투영의 latestSeq 다", async () => {
    setReadStates(serverRows({ 2: { latestSeq: 17, readable: 15, lastReadSeq: 17 } }));
    const host = await mount();
    enterRow(host, DM_ID(2));
    await act(async () => {
      closeButton(host)!.click();
      await Promise.resolve();
    });
    expect(closure.calls).toEqual([{ kind: "PUT", channelId: DM_ID(2), seenSeq: 17 }]);
    // 서버 갈래는 이 기기의 원장에 쓰지 않는다.
    expect(closedDmsFor(WS)).toEqual({});
  });

  it("서버가 거절하면 말한다: 되돌려진 대화가 다시 서 있는 이유", async () => {
    closure.fail = 500;
    setReadStates(serverRows());
    const host = await mount();
    enterRow(host, DM_ID(2));
    await act(async () => {
      closeButton(host)!.click();
      await Promise.resolve();
    });
    await settle();
    expect(host.querySelector('[data-testid="dm-close-error"]')?.textContent).toContain("대화를 닫지 못했어요");
    expect(closedDmsFor(WS)).toEqual({});
  });

  it("경로가 없다고 답하면(405) 이 워크스페이스를 접고 이 닫기를 원장에 쓴다 - 사람이 한 닫기가 사라지지 않는다", async () => {
    closure.fail = 405;
    setReadStates(serverRows({ 2: { latestSeq: 9 } }));
    const host = await mount();
    enterRow(host, DM_ID(2));
    await act(async () => {
      closeButton(host)!.click();
      await Promise.resolve();
    });
    await settle();
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(2))).toBe(9);
    expect(host.querySelector('[data-testid="dm-close-error"]')).toBeNull();
  });

  it("닫은 DM 을 주소로 열면 DELETE 를 한 번 보낸다. 닫은 적 없는 DM 과 나간 상대의 DM 은 아무것도 쓰지 않는다 (D8)", async () => {
    setReadStates(serverRows({ 2: { closedAt: 10 } }));
    await mount(`/c/${DM_ID(2)}`);
    await settle();
    expect(closure.calls).toEqual([{ kind: "DELETE", channelId: DM_ID(2) }]);

    unmountForRemount();
    closure.calls.length = 0;
    resetDmMigrationForTest();
    setReadStates(serverRows());
    await mount(`/c/${DM_ID(1)}`);
    await settle();
    expect(closure.calls).toEqual([]);

    unmountForRemount();
    // 나간 상대의 DM(6번)을 열어도 아무것도 쓰지 않는다: 열려 있는 동안만 보인다.
    setReadStates(serverRows());
    await mount(`/c/${DM_ID(6)}`);
    await settle();
    expect(closure.calls).toEqual([]);
  });

  it("투영이 준비되기 전에는 DELETE 를 보내지 않고, 준비된 뒤 열림 하나당 한 번만 보낸다", async () => {
    readStatesQuery.isPending = true;
    readStatesQuery.data = undefined;
    localStorage.setItem(
      DM_CLOSURE_CACHE_KEY,
      JSON.stringify({ [WS]: { [DM_ID(2)]: [10, 10, 10, 0] } })
    );
    await mount(`/c/${DM_ID(2)}`);
    await settle();
    expect(closure.calls).toEqual([]);
    readStatesQuery.isPending = false;
    setReadStates(serverRows({ 2: { closedAt: 10 } }));
    await rerender();
    await settle();
    await rerender();
    await settle();
    expect(closure.calls).toEqual([{ kind: "DELETE", channelId: DM_ID(2) }]);
  });

  it("콜드 스타트: 사본이 있으면 닫은 DM 이 투영보다 먼저 숨어 있다 (깜빡이지 않는다)", async () => {
    readStatesQuery.isPending = true;
    readStatesQuery.data = undefined;
    localStorage.setItem(
      DM_CLOSURE_CACHE_KEY,
      JSON.stringify({ [WS]: { [DM_ID(2)]: [10, 10, 10, 0], [DM_ID(1)]: [null, 4, 4, 0] } })
    );
    const host = await mount();
    expect(rowIds(host)).not.toContain(DM_ID(2));
    expect(rowIds(host)).toContain(DM_ID(1));
  });

  it("저장소를 지운 뒤(재설치)에는 판정을 미룬다: 골격이 서고, 투영이 오면 닫혀 있다", async () => {
    readStatesQuery.isPending = true;
    readStatesQuery.data = undefined;
    const host = await mount();
    expect(rowIds(host).filter((id) => id !== CH_GENERAL)).toEqual([]);
    expect(host.querySelector('[data-testid="dm-section-pending"]')).not.toBeNull();
    readStatesQuery.isPending = false;
    setReadStates(serverRows({ 2: { closedAt: 10 } }));
    await rerender();
    await settle();
    expect(host.querySelector('[data-testid="dm-section-pending"]')).toBeNull();
    expect(rowIds(host)).not.toContain(DM_ID(2));
    expect(rowIds(host)).toContain(DM_ID(1));
    // 판정이 선 뒤에는 서버 사실의 사본이 저장소에 남는다(다음 콜드 스타트용).
    expect(localStorage.getItem(DM_CLOSURE_CACHE_KEY)).toContain(DM_ID(2));
  });

  it("옛 서버(행이 두 필드를 싣지 않음)는 지금 동작 그대로다: 원장에 쓰고 서버에는 아무것도 보내지 않는다", async () => {
    setReadStates([readState(DM_ID(2), 9)]);
    const host = await mount();
    enterRow(host, DM_ID(2));
    await act(async () => {
      closeButton(host)!.click();
      await Promise.resolve();
    });
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(2))).toBe(9);
    expect(closure.calls).toEqual([]);
  });

  it("원장 이전: 서버가 닫기를 싣는 순간, 숨은 항목만 올리고 올린 항목만 원장에서 지운다", async () => {
    // DM 2 는 숨어 있고(원장 10, 읽을 seq 10), DM 3 은 닫은 뒤 새 메시지로 되살아났다(원장 4, 읽을 seq 9).
    closeDmOnDevice(WS, DM_ID(2), 10);
    closeDmOnDevice(WS, DM_ID(3), 4);
    setReadStates(serverRows({ 2: { latestSeq: 10, readable: 10 }, 3: { latestSeq: 9, readable: 9 } }));
    await mount();
    await settle();
    await settle();
    expect(closure.calls).toEqual([{ kind: "PUT", channelId: DM_ID(2), seenSeq: 10 }]);
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(2))).toBeUndefined();
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(3))).toBe(4);
    expect(JSON.parse(localStorage.getItem(DM_CLOSURE_MIGRATED_KEY) ?? "[]")).toEqual([WS]);
    // 남은 원장 항목(DM 3, 닫은 뒤 사람 글이 와 되살아남)이 있어도 서버 갈래는 그 닫은 뒤의 메시지를 다시 읽지 않는다(#4142 의 경로 제거).
    expect(revival.calls).toEqual([]);
  });

  it("원장 이전은 (기기, 워크스페이스)마다 한 번이다: 표식이 있으면 다시 보내지 않는다", async () => {
    localStorage.setItem(DM_CLOSURE_MIGRATED_KEY, JSON.stringify([WS]));
    closeDmOnDevice(WS, DM_ID(2), 10);
    setReadStates(serverRows({ 2: { latestSeq: 10, readable: 10 } }));
    await mount();
    await settle();
    await settle();
    expect(closure.calls).toEqual([]);
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(2))).toBe(10);
  });

  it("원장 이전에서 한 항목이 실패하면 그 항목만 남는다", async () => {
    closeDmOnDevice(WS, DM_ID(2), 10);
    closeDmOnDevice(WS, DM_ID(3), 10);
    closure.fail = 500;
    setReadStates(serverRows({ 2: { latestSeq: 10 }, 3: { latestSeq: 10 } }));
    await mount();
    await settle();
    await settle();
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(2))).toBe(10);
    expect(closedAtSeqOf(closedDmsFor(WS), DM_ID(3))).toBe(10);
    expect(localStorage.getItem(DM_CLOSURE_MIGRATED_KEY)).toBeNull();
  });

  it("「나간 멤버와의 대화 N개」 줄은 서버 갈래에도 어디에도 없다 (AC 12)", async () => {
    setReadStates(serverRows());
    const host = await mount();
    await settle();
    expect(foldLine(host)).toBeNull();
    expect(closedCount(host)).toBe(1);
  });
});

// ⌥↑·⌥↓는 안 읽은 채널로 간다. 한 번만 보이는 값(연결 값)이 떠 있는 동안은 가지 않는다(#4663):
// 가면 값을 쥔 설정 화면이 내려가 다시 볼 수 없는 값이 사라진다. 걸이는 `@/app/globalShortcutHold`.
describe("안 읽은 채널로 가는 전역 단축키 (⌥↑·⌥↓)", () => {
  const unreadBadge = (host: HTMLElement) =>
    dmRow(host, DM_ID(2)).querySelector('[data-testid="unread-count"]');

  async function pressAltArrow(key: "ArrowUp" | "ArrowDown"): Promise<void> {
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
  }

  it("안 읽은 DM 으로 가고, 걸린 동안은 가지 않는다", async () => {
    setReadStates([readState(DM_ID(2), 9, 3)]);
    const host = await mount("/c/none");
    // 장면이 섰는가: 안 읽은 DM 의 줄에 안 읽음 수가 있다.
    expect(unreadBadge(host)).not.toBeNull();

    const release = holdGlobalShortcuts();
    try {
      await pressAltArrow("ArrowDown");
      expect(unreadBadge(host)).not.toBeNull();
    } finally {
      release();
    }

    await pressAltArrow("ArrowDown");
    // 갔다: 지금 열려 있는 DM 은 읽고 있는 것이라 안 읽음 수가 없다.
    expect(unreadBadge(host)).toBeNull();
  });
});
