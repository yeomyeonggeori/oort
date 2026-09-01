// @vitest-environment jsdom

import { act, createElement, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Channel } from "@momo/core/lib/api";
import {
  deriveSidebarSections,
  emptySidebarPrefs,
  SIDEBAR_PREFS_SAVE_FAILURE,
  type SidebarPrefs,
} from "@momo/core/features/sidebar/sidebarSections";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { sectionUnreadTotals } from "./sidebarSectionModel";
import {
  reloadSidebarSectionPreferenceForTest,
  setSidebarSectionCollapsed,
  sidebarSectionsCollapsed,
  useSidebarSectionsCollapsed,
} from "./sidebarSectionPreference";
import {
  SIDEBAR_PREFS_SAVE_DEBOUNCE_MS,
  useSidebarPrefs,
} from "./useSidebarPrefs";

// =============================================================================
// BT-4(#1932) 클라 절반의 red proof.
//
// 브리프가 이름 댄 셋을 그대로 판다:
//   1. 섹션 생성 → 채널 이동 → 새로고침(목 GET) 뒤 구조 생존
//   2. 커스텀 섹션의 접기 + unread 집계 (기존 섹션과 **같은 자**)
//   3. 죽은 채널 id 필터
// 여기에 저장 실패의 롤백 + 배너 문장, 그리고 디바운스가 마지막 하나만 보낸다는
// 사실을 더한다 - 그 둘이 없으면 1번은 「어쨌든 저장되더라」로 통과할 수 있다.
//
// 픽스처는 얕은 구현에 적대적이다: 여러 섹션, 80자 한글 이름, 아무 채널도
// 가리키지 않는 id 를 한 payload 에 함께 싣는다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const RELEASE = "00000000-0000-7000-8000-000000000202";
const RANDOM = "00000000-0000-7000-8000-000000000203";
/** 어느 채널도 아닌 id. 서버는 이것을 저장한다(ADR-0177 D3 관용 계약). */
const DEAD = "00000000-0000-4000-8000-0000deadbeef";

const fetchSidebarPrefs = vi.hoisted(() => vi.fn());
const putSidebarPrefs = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/sidebar/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@momo/core/features/sidebar/api")>();
  return {
    ...actual,
    fetchSidebarPrefs: (ws: string) =>
      fetchSidebarPrefs(ws) as Promise<SidebarPrefs>,
    putSidebarPrefs: (ws: string, prefs: SidebarPrefs) =>
      putSidebarPrefs(ws, prefs) as Promise<SidebarPrefs>,
  };
});

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  fetchSidebarPrefs.mockReset();
  fetchSidebarPrefs.mockResolvedValue(emptySidebarPrefs());
  putSidebarPrefs.mockReset();
  putSidebarPrefs.mockImplementation((_ws: string, prefs: SidebarPrefs) =>
    Promise.resolve(prefs)
  );
  reloadSidebarSectionPreferenceForTest(null);
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
  reloadSidebarSectionPreferenceForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function channelFixture(id: string, name: string): Channel {
  return { id, workspaceId: WS, kind: "public", name, muted: false };
}

const CHANNELS: Channel[] = [
  channelFixture(GENERAL, "일반"),
  channelFixture(RELEASE, "출시"),
  channelFixture(RANDOM, "잡담"),
];

/** 조작 손잡이를 시험에 내주는 최소 화면. 실제 Sidebar 와 같은 훅·같은 파생이다. */
interface Handle {
  create: (name: string) => void;
  move: (channelId: string, sectionId: string | null) => void;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  error: () => string | null;
}
let handle: Handle | null = null;

function Harness({ unread }: { unread?: Record<string, number> }) {
  const prefs = useSidebarPrefs(WS);
  const sections = useMemo(
    () =>
      deriveSidebarSections({
        prefs: prefs.prefs,
        channels: CHANNELS,
        dms: [],
      }),
    [prefs.prefs]
  );
  handle = {
    create: prefs.createSection,
    move: prefs.moveChannel,
    remove: prefs.deleteSection,
    rename: prefs.renameSection,
    error: () => prefs.error,
  };
  const collapsed = useSidebarSectionsCollapsed();
  return createElement(
    "nav",
    null,
    sections.map((section) => {
      const totals = sectionUnreadTotals(
        section.channels.map((channel) => ({
          unreadCount: unread?.[channel.id] ?? 0,
          mentionCount: 0,
        }))
      );
      return createElement(SidebarSection, {
        key: section.id,
        title: section.title,
        sectionId: section.id,
        collapsed: collapsed[section.id] === true,
        onCollapsedChange: (next: boolean) =>
          setSidebarSectionCollapsed(section.id, next),
        unreadCount: totals.unreadCount,
        mentionCount: totals.mentionCount,
        children: section.channels.map((channel) =>
          createElement(SidebarRow, {
            key: channel.id,
            to: `/c/${channel.id}`,
            icon: null as ReactNode,
            label: channel.name ?? channel.id,
            testId: "channel-item",
            dataAttrs: { "data-channel-id": channel.id },
          })
        ),
      });
    })
  );
}

async function mount(props: { unread?: Record<string, number> } = {}) {
  mountedHost = document.createElement("div");
  document.body.append(mountedHost);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  mountedRoot = createRoot(mountedHost);
  await act(async () => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(Harness, props)
        )
      )
    );
  });
  // 부트스트랩 GET 은 프라미스다. 가짜 타이머 아래서도 마이크로태스크는 그냥
  // 흐르므로, 몇 번 비워 주면 첫 payload 가 화면에 앉는다.
  // react-query 의 알림은 `notifyManager` 를 거쳐 매크로태스크로 나가므로,
  // 마이크로태스크만 비우면 첫 payload 가 렌더에 닿지 않는다. 1ms 씩만 민다 -
  // 디바운스(2000ms)는 건드리지 않는다.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      if (vi.isFakeTimers()) vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
  }
  return mountedHost;
}

function sectionIds(host: HTMLElement): string[] {
  return Array.from(
    host.querySelectorAll<HTMLElement>("[data-testid^='sidebar-section-']")
  )
    .filter((el) => !el.dataset.testid?.endsWith("-header"))
    .map((el) => (el.dataset.testid ?? "").replace("sidebar-section-", ""));
}

function channelsIn(host: HTMLElement, sectionId: string): string[] {
  const section = host.querySelector<HTMLElement>(
    `[data-testid='sidebar-section-${sectionId}']`
  );
  return Array.from(
    section?.querySelectorAll<HTMLElement>("[data-channel-id]") ?? []
  ).map((el) => el.dataset.channelId ?? "");
}

/** 디바운스가 다 지나고 PUT 의 프라미스까지 정착시킨다. */
async function settleSave() {
  await act(async () => {
    vi.advanceTimersByTime(SIDEBAR_PREFS_SAVE_DEBOUNCE_MS);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("red proof 1 — 만들고, 옮기고, 새로고침해도 살아 있다", () => {
  it("생성과 이동이 한 번의 PUT 으로 저장되고 다음 부트스트랩에서 되살아난다", async () => {
    vi.useFakeTimers();
    const host = await mount();
    expect(sectionIds(host)).toEqual(["channels", "dms"]);

    await act(async () => handle?.create("출시 준비"));
    await act(async () => handle?.move(RELEASE, "sec-1"));

    // 아직 아무것도 나가지 않았다: 정리하는 손이 멈춘 뒤에 한 번만 나간다.
    expect(putSidebarPrefs).not.toHaveBeenCalled();
    // 그런데 화면은 이미 옮겨져 있다 - 왕복을 기다리지 않는 것이 이 문법이다.
    expect(sectionIds(host)).toEqual(["channels", "sec-1", "dms"]);
    expect(channelsIn(host, "sec-1")).toEqual([RELEASE]);
    expect(channelsIn(host, "channels")).toEqual([GENERAL, RANDOM]);

    await settleSave();
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    const saved = putSidebarPrefs.mock.calls[0][1] as SidebarPrefs;
    expect(saved.sections).toHaveLength(1);
    expect(saved.sections[0].name).toBe("출시 준비");
    expect(saved.sections[0].channelIds).toEqual([RELEASE]);

    // 새로고침: 다음 부트스트랩 GET 이 방금 저장된 payload 를 돌려준다.
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountedHost?.remove();
    fetchSidebarPrefs.mockResolvedValue(saved);
    const reloaded = await mount();
    expect(sectionIds(reloaded)).toEqual(["channels", "sec-1", "dms"]);
    expect(channelsIn(reloaded, "sec-1")).toEqual([RELEASE]);
  });

  it("연달아 만진 것은 마지막 상태 하나로만 나간다", async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => handle?.create("가"));
    await act(async () => handle?.create("나"));
    await act(async () => handle?.move(GENERAL, "sec-1"));
    await act(async () => handle?.move(GENERAL, "sec-2"));
    await settleSave();

    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    const saved = putSidebarPrefs.mock.calls[0][1] as SidebarPrefs;
    expect(saved.sections.map((s) => s.id)).toEqual(["sec-1", "sec-2"]);
    // 옮기기는 복사가 아니다.
    expect(saved.sections[0].channelIds).toEqual([]);
    expect(saved.sections[1].channelIds).toEqual([GENERAL]);
  });

  it("섹션을 지우면 그 채널이 기본 섹션으로 돌아온다", async () => {
    vi.useFakeTimers();
    const host = await mount();
    await act(async () => handle?.create("출시 준비"));
    await act(async () => handle?.move(RELEASE, "sec-1"));
    expect(channelsIn(host, "channels")).toEqual([GENERAL, RANDOM]);

    await act(async () => handle?.remove("sec-1"));
    expect(sectionIds(host)).toEqual(["channels", "dms"]);
    expect(channelsIn(host, "channels")).toEqual([GENERAL, RELEASE, RANDOM]);
  });
});

describe("red proof 2 — 커스텀 섹션도 같은 기계를 탄다", () => {
  it("접기와 unread 집계가 기본 섹션과 같은 자를 쓴다", async () => {
    vi.useFakeTimers();
    const host = await mount({ unread: { [RELEASE]: 4, [GENERAL]: 2 } });
    await act(async () => handle?.create("출시 준비"));
    await act(async () => handle?.move(RELEASE, "sec-1"));

    // 펼친 동안에는 행이 말하므로 헤더에 수가 없다 - 기본 섹션과 같은 규칙.
    expect(
      host.querySelector("[data-testid='section-unread-sec-1']")
    ).toBeNull();

    const collapse = host.querySelector<HTMLButtonElement>(
      "[data-testid='section-collapse-sec-1']"
    );
    expect(collapse).not.toBeNull();
    await act(async () => collapse?.click());

    // 접히면 행이 사라지고 헤더가 그 합을 이고 있다.
    expect(channelsIn(host, "sec-1")).toEqual([]);
    expect(
      host.querySelector("[data-testid='section-unread-sec-1']")?.textContent
    ).toBe("4");
    // 기본 섹션은 자기 합만 센다.
    expect(collapse?.getAttribute("aria-expanded")).toBe("false");

    // 접힘은 기기의 것이다(ADR-0177 D4): localStorage 원장에 남고 서버 payload
    // 에는 없다.
    expect(sidebarSectionsCollapsed()["sec-1"]).toBe(true);
    await settleSave();
    const saved = putSidebarPrefs.mock.calls[0][1] as SidebarPrefs;
    expect(JSON.stringify(saved)).not.toContain("collapsed");
  });
});

describe("red proof 3 — 죽은 채널 id", () => {
  it("아무 채널도 아닌 id 는 그려지지 않고 섹션을 무너뜨리지도 않는다", async () => {
    vi.useFakeTimers();
    fetchSidebarPrefs.mockResolvedValue({
      version: 1,
      sections: [
        {
          id: "sec-1",
          // 80자 한글. 바이트를 세는 곳이 있으면 여기서 드러난다.
          name: "긴급대응".repeat(20),
          order: 0,
          channelIds: [DEAD, RELEASE, DEAD],
        },
        { id: "sec-2", name: "지난 분기", order: 1, channelIds: [DEAD] },
      ],
      starredChannelIds: [],
    } satisfies SidebarPrefs);
    const host = await mount();

    expect(sectionIds(host)).toEqual(["channels", "sec-1", "sec-2", "dms"]);
    expect(channelsIn(host, "sec-1")).toEqual([RELEASE]);
    // 죽은 id 만 담긴 섹션은 **빈 섹션**이지 사라진 섹션이 아니다.
    expect(channelsIn(host, "sec-2")).toEqual([]);
    // 나머지는 기본 섹션에 남는다.
    expect(channelsIn(host, "channels")).toEqual([GENERAL, RANDOM]);
    const title = host.querySelector(
      "[data-testid='section-collapse-sec-1']"
    )?.textContent;
    expect([...(title ?? "")].length).toBe(80);
  });
});

describe("저장 실패", () => {
  it("되돌리고 그 자리에서 문장으로 말한다", async () => {
    vi.useFakeTimers();
    putSidebarPrefs.mockRejectedValue(new Error("boom"));
    const host = await mount();

    await act(async () => handle?.create("출시 준비"));
    expect(sectionIds(host)).toEqual(["channels", "sec-1", "dms"]);

    await settleSave();
    // 화면이 성공을 말했다가 조용히 번복하지 않는다: 섹션은 사라지고, 사라진
    // 이유가 문장으로 선다.
    expect(sectionIds(host)).toEqual(["channels", "dms"]);
    expect(handle?.error()).toBe(SIDEBAR_PREFS_SAVE_FAILURE);
  });

  it("실패 뒤 다시 만들면 다시 시도한다", async () => {
    vi.useFakeTimers();
    putSidebarPrefs.mockRejectedValueOnce(new Error("boom"));
    const host = await mount();
    await act(async () => handle?.create("가"));
    await settleSave();
    expect(handle?.error()).toBe(SIDEBAR_PREFS_SAVE_FAILURE);

    await act(async () => handle?.create("나"));
    // 새 편집은 앞의 실패 문장을 걷는다 - 지금 화면에 있는 것은 실패가 아니다.
    expect(handle?.error()).toBeNull();
    await settleSave();
    expect(putSidebarPrefs).toHaveBeenCalledTimes(2);
    expect(sectionIds(host)).toEqual(["channels", "sec-1", "dms"]);
  });
});
