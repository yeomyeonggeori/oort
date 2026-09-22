// @vitest-environment jsdom

import {
  act,
  createElement,
  useState,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { visibleCommands } from "@momo/core/features/commands/registry";
import {
  COMMAND_USAGE_STORAGE_KEY,
  parseCommandUsage,
} from "@momo/core/features/commands/usage";
import { OPEN_INBOX_SHORTCUT } from "@/app/keyboardShortcuts";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import {
  PALETTE_STATUS_HOLD_MS,
  QuickSwitcher,
  usePaletteStatus,
} from "./QuickSwitcher";

// =============================================================================
// ⌘K 「명령」 그룹 (ADR-0186 D1) · 팔레트 상태줄 (ADR-0182 ②).
//
// 「하네스 참·제품 거짓」을 피하는 것이 이 파일의 규율이다. 세 가지가 그 규율의
// 모양이다:
//
//   ① **항목 수와 그룹 존재는 렌더 DOM으로 잰다.** 숫자를 여기 심지 않고
//      `visibleCommands(env)`에서 뽑는다 — 그래서 환경이 바뀌면 기대값이 같이
//      움직이고, 「10개여야 한다」가 화석이 되는 일이 없다.
//   ② **`open`은 상태다.** 팔레트가 스스로 닫히는 것이 제품의 동작이므로
//      `onOpenChange`를 no-op으로 두고 열린 팔레트를 재면, 제품에 없는 화면을
//      재는 것이 된다.
//   ③ **3s 상태줄은 표면을 열어 둔 채 끝나는 명령의 것**이라, 그 시험은
//      레지스트리 명령이 아니라 훅(`usePaletteStatus`)을 직접 잰다. 지금
//      레지스트리 명령은 전부 실행과 동시에 닫히고(`closesSurface`), 그 사실
//      자체는 ②의 시험이 잡는다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";
const AGENT_ID = "00000000-0000-7000-8000-000000000102";
const CH = "00000000-0000-7000-8000-000000000201";

const channels: Channel[] = [
  { id: CH, workspaceId: WS, kind: "public", name: "배포", muted: false },
];

/** 이 렌더가 서 있는 환경. 각 시험이 바꾸고, 기대값도 여기서 나온다. */
const world = {
  showDrafts: true,
  role: "owner" as RosterMember["role"],
  surfacesProvided: true,
  agents: [] as RosterMember[],
};

function agent(): RosterMember {
  return {
    id: AGENT_ID,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: "김인턴",
    handle: "intern",
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
  };
}

function self(): RosterMember {
  return {
    id: MEMBER_ID,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    role: world.role,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
  };
}

vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@momo/core/features/capabilities/serverSurfaces")
    >();
  return {
    ...actual,
    isSurfaceProvided: (id: string) =>
      id === "workConsole" || id === "workstreams"
        ? world.surfacesProvided
        : actual.isSurfaceProvided(
            id as import("@momo/core/features/capabilities/serverSurfaces").SurfaceId
          ),
  };
});

vi.mock("@/features/channels/useCreateChannel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/channels/useCreateChannel")>();
  return {
    ...actual,
    useOpenCreateChannel: () => openCreateChannel,
    useCreateChannelOpen: () => false,
  };
});

vi.mock("@/features/routing/useAgentProfile", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/routing/useAgentProfile")>();
  return { ...actual, useOpenAgentProfile: () => openAgentProfile };
});

vi.mock("@/features/drafts/useDraftsPanel", () => ({
  useDraftsPanel: () => ({ showNav: world.showDrafts }),
}));

vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      isPending: false,
      isSuccess: true,
      isError: false,
      data: channels,
      groups: { channels, dms: [] },
      refetch: () => undefined,
    }),
    useDirectory: () => ({
      directory: actual.makeDirectory([self(), ...world.agents]),
      isPending: false,
      refetch: () => undefined,
    }),
  };
});

const openCreateChannel = vi.fn();
const openAgentProfile = vi.fn();

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;
let currentPath = "";

function LocationProbe() {
  const location = useLocation();
  currentPath = `${location.pathname}${location.search}`;
  return null;
}

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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * `open`을 **상태로** 쥔 호스트.
 *
 * 제품에서 팔레트를 닫는 것은 App의 상태다. no-op `onOpenChange`로 세우면
 * 「Enter를 눌러도 열려 있는 팔레트」라는, 제품에 없는 화면을 재게 된다.
 */
let setPaletteOpen: ((open: boolean) => void) | null = null;
let openChangeCalls: boolean[] = [];

function Host({ actionsResponse }: { actionsResponse?: unknown }) {
  const [open, setOpen] = useState(true);
  setPaletteOpen = setOpen;
  return createElement(QuickSwitcher, {
    open,
    onOpenChange: (next: boolean) => {
      openChangeCalls.push(next);
      setOpen(next);
    },
    actionsResponse,
  });
}

async function mount(
  options: { path?: string; actionsResponse?: unknown } = {}
): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const tree: ReactElement = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        MemoryRouter,
        { initialEntries: [options.path ?? "/inbox"] },
        createElement(LocationProbe),
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: "*",
            element: createElement(Host, {
              actionsResponse: options.actionsResponse,
            }),
          })
        )
      )
    )
  );
  await act(async () => {
    mountedRoot?.render(tree);
    await Promise.resolve();
  });
  await settle();
}

/** 「명령」 그룹의 머리글 노드. 없으면 그룹이 없는 것이다. */
function commandGroup(): HTMLElement | null {
  const headings = [
    ...document.querySelectorAll("[cmdk-group-heading]"),
  ] as HTMLElement[];
  const heading = headings.find((node) => node.textContent === "명령");
  return heading?.closest("[cmdk-group]") ?? null;
}

function commandRows(): HTMLElement[] {
  const group = commandGroup();
  if (group === null) return [];
  return [...group.querySelectorAll("[data-command-id]")] as HTMLElement[];
}

/** 이 환경에서 레지스트리가 내놓는 명령. 기대값은 전부 여기서 나온다. */
function expectedCommands() {
  return visibleCommands({
    showDrafts: world.showDrafts,
    canCreateChannel: world.role === "owner" || world.role === "admin",
    isSurfaceProvided: (id) =>
      id === "workConsole" || id === "workstreams" ? world.surfacesProvided : false,
    agents: world.agents.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      handle: member.handle,
    })),
  });
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
  world.showDrafts = true;
  world.role = "owner";
  world.surfacesProvided = true;
  world.agents = [];
  openChangeCalls = [];
  setPaletteOpen = null;
  currentPath = "";
  openCreateChannel.mockReset();
  openAgentProfile.mockReset();
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    mountedRoot?.unmount();
  });
  mountedRoot = null;
  mountedHost?.remove();
  mountedHost = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("「명령」 그룹은 레지스트리를 그린다", () => {
  it("모든 조건이 참일 때 줄 수가 레지스트리와 같다", async () => {
    world.agents = [agent()];
    await mount();
    const expected = expectedCommands();
    expect(expected.length).toBeGreaterThanOrEqual(10);
    expect(commandRows().map((row) => row.dataset.commandId)).toEqual(
      expected.map((command) => command.id)
    );
  });

  it("환경이 줄어들면 줄도 같이 줄어든다", async () => {
    world.showDrafts = false;
    world.role = "member";
    world.surfacesProvided = false;
    world.agents = [];
    await mount();
    const expected = expectedCommands();
    const rendered = commandRows().map((row) => row.dataset.commandId);
    expect(rendered).toEqual(expected.map((command) => command.id));
    expect(rendered).not.toContain("nav.drafts");
    expect(rendered).not.toContain("create.channel");
    expect(rendered).not.toContain("nav.workConsole");
    expect(rendered).not.toContain("nav.workstreams");
    // 두 환경의 숫자가 실제로 다르다 — 그래야 이 시험이 무언가를 잰다.
    expect(rendered.length).toBeLessThan(10);
  });

  it("옛 머리글 셋 대신 「명령」 하나다", async () => {
    await mount();
    const headings = [...document.querySelectorAll("[cmdk-group-heading]")].map(
      (node) => node.textContent
    );
    expect(headings).toContain("명령");
    expect(headings).not.toContain("이동");
    expect(headings).not.toContain("만들기");
    expect(headings).not.toContain("에이전트 설정");
    // 회귀 우선: 검색 그룹과 사람/채널 섹션은 그대로 있다.
    expect(headings).toContain("채널");
  });

  it("단축키가 있는 줄만 키캡을 그리고, 그 글자는 정본에서 온다", async () => {
    await mount();
    const inbox = commandRows().find(
      (row) => row.dataset.commandId === "nav.inbox"
    );
    const activity = commandRows().find(
      (row) => row.dataset.commandId === "nav.activity"
    );
    expect([...(inbox?.querySelectorAll("kbd") ?? [])].map((k) => k.textContent))
      .toEqual([...OPEN_INBOX_SHORTCUT.keycaps]);
    expect(activity?.querySelectorAll("kbd")).toHaveLength(0);
  });

  it("에이전트 줄이 멤버 id를 싣는다", async () => {
    world.agents = [agent()];
    await mount();
    const routing = commandRows().filter(
      (row) => row.dataset.testid === "switcher-agent-routing"
    );
    expect(routing).toHaveLength(1);
    expect(routing[0]?.dataset.memberId).toBe(AGENT_ID);
  });
});

describe("명령을 실행하면 표면이 닫힌다", () => {
  it("인박스 줄이 이동시키고 팔레트를 닫는다", async () => {
    await mount({ path: "/activity" });
    const inbox = commandRows().find(
      (row) => row.dataset.commandId === "nav.inbox"
    )!;
    await act(async () => {
      inbox.click();
    });
    await settle();
    expect(currentPath).toBe("/inbox");
    expect(openChangeCalls).toContain(false);
    // ②: 닫힌 뒤에는 팔레트 자체가 없다 — 상태줄도 함께 사라진다.
    expect(document.querySelector('[data-testid="quick-switcher"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="quick-switcher-status"]')
    ).toBeNull();
  });

  it("채널 만들기 줄은 한 프레임 뒤에 폼을 연다", async () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
    try {
      await mount();
      const create = commandRows().find(
        (row) => row.dataset.commandId === "create.channel"
      )!;
      await act(async () => {
        create.click();
      });
      // 같은 커밋에서는 아직 열리지 않았다: 팔레트가 먼저 캐럿을 돌려놓는다.
      expect(openCreateChannel).not.toHaveBeenCalled();
      expect(openChangeCalls).toContain(false);
      await act(async () => {
        for (const frame of frames) frame(0);
      });
      expect(openCreateChannel).toHaveBeenCalledTimes(1);
    } finally {
      raf.mockRestore();
    }
  });

  it("실행 기록이 저장되고 다음에 열 때 맨 위로 온다", async () => {
    await mount({ path: "/activity" });
    const before = commandRows().map((row) => row.dataset.commandId);
    expect(before[0]).not.toBe("nav.settings");

    const settings = commandRows().find(
      (row) => row.dataset.commandId === "nav.settings"
    )!;
    await act(async () => {
      settings.click();
    });
    await settle();

    expect(
      parseCommandUsage(localStorage.getItem(COMMAND_USAGE_STORAGE_KEY)).recent
    ).toEqual(["nav.settings"]);

    await act(async () => {
      setPaletteOpen?.(true);
    });
    await settle();
    expect(commandRows()[0]?.dataset.commandId).toBe("nav.settings");
  });

  it("저장이 막혀 있어도 팔레트는 그려진다", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("SecurityError");
      });
    try {
      await mount({ path: "/activity" });
      expect(commandRows().length).toBeGreaterThan(0);
      const inbox = commandRows().find(
        (row) => row.dataset.commandId === "nav.inbox"
      )!;
      await act(async () => {
        inbox.click();
      });
      await settle();
      expect(currentPath).toBe("/inbox");
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });
});

describe("서버 행동 카탈로그는 없으면 숨는다 (ADR-0186 부록 E)", () => {
  it("라우트가 없는 서버(404)에서는 행동 줄이 0이다 — 팔레트가 묻고, 답이 없으면 숨는다", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(JSON.stringify({ error: { message: "not found", input } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await settle();
    expect(document.querySelectorAll("[data-action-id]")).toHaveLength(0);
    // 묻기는 했다. 「요청을 안 보내서 0개」와 「물었는데 없어서 0개」는 다른
    // 사실이고, AX-4 가 바꾼 것이 정확히 그 차이다.
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).endsWith(`/v1/workspaces/${WS}/actions`)
      )
    ).toBe(true);
  });

  it("실패는 재시도하지 않는다 — 곁들여 서는 목록이 팔레트를 붙잡지 않는다", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await settle();
    await settle();
    expect(document.querySelectorAll("[data-action-id]")).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).endsWith("/actions")
      )
    ).toHaveLength(1);
  });

  it("시험이 본문을 건네면 요청은 나가지 않는다 (prop 은 서버 대신 답하는 자리다)", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) => new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await mount({ actionsResponse: { actions: [] } });
    await settle();
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).endsWith("/actions")
      )
    ).toHaveLength(0);
  });

  it("모양이 어긋난 응답도 0이다 — 반쯤 아는 목록은 그리지 않는다", async () => {
    await mount({
      actionsResponse: {
        actions: [
          {
            id: "invite.create",
            title: "팀원 초대 링크 만들기",
            summary: "",
            risk: "approval",
            requiredRole: "admin",
            executable: true,
            unavailableReason: null,
          },
          { id: "channel.create", risk: "nope" },
        ],
      },
    });
    expect(document.querySelectorAll("[data-action-id]")).toHaveLength(0);
  });

  it("계약대로 온 카탈로그는 자기 그룹으로 선다", async () => {
    await mount({
      actionsResponse: {
        actions: [
          {
            id: "invite.create",
            title: "팀원 초대 링크 만들기",
            summary: "관리자 권한으로 초대 링크를 만듭니다.",
            risk: "approval",
            requiredRole: "admin",
            executable: true,
            unavailableReason: null,
          },
        ],
      },
    });
    const rows = [...document.querySelectorAll("[data-action-id]")];
    expect(rows).toHaveLength(1);
    expect((rows[0] as HTMLElement).dataset.actionId).toBe("invite.create");
    // 명령 그룹과 섞이지 않는다.
    expect(commandRows().some((row) => row.dataset.actionId)).toBe(false);
  });

  it("v1 에서 Enter 는 그 일을 직접 할 수 있는 설정 표면으로 데려간다", async () => {
    await mount({
      actionsResponse: {
        actions: [
          {
            id: "invite.create",
            title: "팀원 초대 링크 만들기",
            summary: "관리자 권한으로 초대 링크를 만듭니다.",
            risk: "approval",
            requiredRole: "admin",
            executable: true,
            unavailableReason: null,
          },
        ],
      },
    });
    const row = document.querySelector(
      '[data-action-id="invite.create"]'
    ) as HTMLElement;
    expect(row.getAttribute("aria-disabled")).not.toBe("true");
    expect(row.textContent).toContain("설정에서 직접 하기");
    await act(async () => {
      row.click();
    });
    await settle();
    expect(currentPath).toBe("/settings?section=members");
    // 팔레트는 명령과 같은 규율로 닫힌다.
    expect(openChangeCalls).toContain(false);
  });

  it("목적지를 모르거나 실행기가 없으면 줄은 눌리지 않는다", async () => {
    await mount({
      actionsResponse: {
        actions: [
          {
            id: "channel.archive",
            title: "채널 보관",
            summary: "이 빌드가 목적지를 모르는 행동.",
            risk: "approval",
            requiredRole: "admin",
            executable: true,
            unavailableReason: null,
          },
          {
            id: "invite.create",
            title: "팀원 초대 링크 만들기",
            summary: "이 서버에는 실행기가 없다.",
            risk: "approval",
            requiredRole: "admin",
            executable: false,
            unavailableReason: "이 서버에는 아직 없습니다.",
          },
        ],
      },
    });
    const rows = [
      ...document.querySelectorAll("[data-action-id]"),
    ] as HTMLElement[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.textContent).not.toContain("설정에서 직접 하기");
    }
    expect(rows[1]?.textContent).toContain("이 서버에는 아직 없습니다.");
    await act(async () => {
      rows[0]?.click();
    });
    await settle();
    // 아무 데도 가지 않았다. 처음 서 있던 자리 그대로다.
    expect(currentPath).toBe("/inbox");
    expect(openChangeCalls).not.toContain(false);
  });
});

// ---- 상태줄 (ADR-0182 ②) ----------------------------------------------------

function StatusProbe({ open }: { open: boolean }) {
  const { status, announce } = usePaletteStatus(open);
  announceRef = announce;
  return createElement(
    "p",
    { role: "status", "data-testid": "probe-status" },
    status
  );
}

let announceRef: ((text: string | null) => void) | null = null;

describe("팔레트 상태줄", () => {
  function probeText(): string {
    return (
      document.querySelector('[data-testid="probe-status"]')?.textContent ?? ""
    );
  }

  async function mountProbe(open: boolean): Promise<void> {
    const host = document.createElement("div");
    document.body.append(host);
    mountedHost = host;
    mountedRoot = createRoot(host);
    await act(async () => {
      mountedRoot?.render(createElement(StatusProbe, { open }));
      await Promise.resolve();
    });
  }

  async function renderProbe(open: boolean): Promise<void> {
    await act(async () => {
      mountedRoot?.render(createElement(StatusProbe, { open }));
      await Promise.resolve();
    });
  }

  // 시간은 **오직 여기서만** 흐른다. `shouldAdvanceTime: true`는 가짜 시계를
  // 진짜 시간과 함께 굴려서, 부하가 걸린 머신에서는 단정 전에 3s가 지나 버린다
  // (병합 트리 전체 스위트에서 실측). 타이머를 재는 시험은 시간을 손으로만
  // 밀어야 「3s 뒤에 사라진다」와 「언젠가 사라진다」를 구별한다.
  it("문장을 쥐었다가 3s 뒤에 놓는다", async () => {
    vi.useFakeTimers();
    await mountProbe(true);
    await act(async () => {
      announceRef?.("액센트를 새벽으로 바꿨습니다");
    });
    expect(probeText()).toBe("액센트를 새벽으로 바꿨습니다");

    await act(async () => {
      vi.advanceTimersByTime(PALETTE_STATUS_HOLD_MS - 1);
    });
    expect(probeText()).toBe("액센트를 새벽으로 바꿨습니다");

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(probeText()).toBe("");
  });

  it("다시 열면 지난 회차의 문장이 없다", async () => {
    vi.useFakeTimers();
    await mountProbe(true);
    await act(async () => {
      announceRef?.("설정으로 이동");
    });
    expect(probeText()).toBe("설정으로 이동");

    // 닫는다: 지우지 않는다 — 닫히는 동안 낭독될 문장이다.
    await renderProbe(false);
    expect(probeText()).toBe("설정으로 이동");

    // 연다: 지운다.
    await renderProbe(true);
    expect(probeText()).toBe("");
  });

  it("라이브 리전 노드는 문장이 없어도 문서에 있다", async () => {
    await mount();
    const region = document.querySelector(
      '[data-testid="quick-switcher-status"]'
    );
    expect(region).not.toBeNull();
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");
  });
});
