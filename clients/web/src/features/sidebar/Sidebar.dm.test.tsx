// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel, ReadState, RosterMember } from "@momo/core/lib/api";
import { emptySidebarPrefs } from "@momo/core/features/sidebar/sidebarSections";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ShellNavProvider } from "@/app/shellNav";
import { Sidebar } from "./Sidebar";
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
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchAgentLiveness: async (_ws: string, agentId: string) => {
      const state = liveness.byAgent.get(agentId.toLowerCase());
      if (state === undefined) throw new actual.ApiError(404, "not found");
      if (state === "pending") return new Promise(() => undefined);
      return { agentMemberId: agentId, state };
    },
  };
});

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => channelsQuery,
    useDirectory: () => ({
      directory: makeDirectory(roster),
      isPending: false,
      isLoading: false,
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
  liveness.byAgent.clear();
  touch.hoverNone = false;
  localStorage.clear();
  reloadClosedDmsForTest(null);
  readStatesQuery.isPending = false;
  readStatesQuery.isError = false;
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
    const ghostRow = dmRow(host, DM_ID(6));
    expect(ghostRow.textContent).toContain("나간 멤버");
    expect(ghostRow.querySelector('[data-testid="dm-avatar"]')?.getAttribute("data-avatar-kind")).toBe("unknown");
  });
});

// =============================================================================
// DM 호버 X · 사이드바에서 닫기 (#3963)
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
    expect(x.getAttribute("aria-label")).toBe("이도현, 사이드바에서 닫기");
    expect(x.tabIndex).toBe(-1);
    // 링크 안의 버튼이 아니다: 앵커 안의 상호작용 콘텐츠는 클릭이 어느 쪽인지 브라우저마다 다르다.
    expect(dmRow(host, DM_ID(1)).contains(x)).toBe(false);
    // 같은 행 메뉴 트리거 상자 안에 선다: X 위의 우클릭도 행 메뉴를 연다.
    expect(x.closest("[data-row-menu-trigger]")).toBe(
      dmRow(host, DM_ID(1)).closest("[data-row-menu-trigger]")
    );
  });

  it("X 가 선 동안 링크가 알린다: 알약·점을 내리고 그 자리를 비운다(tokens.css)", async () => {
    setReadStates([readState(DM_ID(1), 12, 10)]);
    const host = await mount();
    const link = dmRow(host, DM_ID(1));
    expect(link.hasAttribute("data-row-close")).toBe(false);
    enterRow(host, DM_ID(1));
    expect(link.hasAttribute("data-row-close")).toBe(true);
    // 알약은 오른쪽 끝 덩어리 안에 있고, 그 덩어리 하나가 내려간다.
    expect(link.querySelector('[data-row-trailing] [data-testid="unread-count"]')).not.toBeNull();
    leaveRow(host, DM_ID(1));
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

  it("에이전트: 생존 판정이 점이 된다 — 응답함은 채운 초록, 살아 있음은 채운 회색, 꺼짐은 속이 빈 고리", async () => {
    // 모양이 말한다(낱말이 없는 자리): 채운 점 = 신호가 오고 있다, 속 빈 고리 = 응답을 기대하기 어렵다.
    // 「살아 있지만 일이 없는」 에이전트와 「꺼진」 에이전트가 한 점이면 점이 질문에 답하지 못한다 (#3964 H1).
    const cases: Array<[string, string, string[], string[]]> = [
      ["responsive", "ok", ["bg-ok", "border-surface"], ["bg-surface", "bg-ink-muted"]],
      ["alive_idle", "idle", ["bg-ink-muted", "border-surface"], ["bg-surface", "bg-ok"]],
      ["inactive", "muted", ["bg-surface", "border-line-strong"], ["bg-ok", "bg-ink-muted"]],
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
    const host = await mount();
    await settle();
    for (const id of [DM_ID(1), DM_ID(2), DM_ID(6)]) {
      expect(dotOf(host, id)).toBeNull();
    }
    // 그리고 회색(idle·muted)이 어디 있든 그것은 에이전트 행이다.
    const gray = [...host.querySelectorAll('[data-testid="dm-peer-dot"][data-tone="muted"], [data-testid="dm-peer-dot"][data-tone="idle"]')];
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
