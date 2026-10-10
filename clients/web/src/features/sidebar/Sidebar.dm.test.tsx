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

vi.mock("@/features/emoji/useHoverNone", () => ({
  useHoverNone: () => false,
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
    useReadStates: () => ({ byChannel: new Map(), isPending: false, error: null }),
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

async function mount(): Promise<HTMLElement> {
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
    const host = await mount();
    const dot = (id: string) => dmRow(host, id).querySelector('[data-testid="dm-avatar"]')!.getAttribute("data-peer-dot");
    expect(dot(DM_ID(1))).toBeNull();
    expect(dot(DM_ID(3))).toBe("away");
    expect(dot(DM_ID(4))).toBe("online");
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
