// @vitest-environment jsdom

import {
  act,
  createElement,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
  SIDEBAR_SORT_ALPHA,
  SIDEBAR_SORT_MANUAL,
  SIDEBAR_STARRED_TOUCH_HINT,
  type SidebarPrefs,
} from "@momo/core/features/sidebar/sidebarSections";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { SidebarRowContextMenu } from "./SidebarRowContextMenu";
import {
  SidebarSectionMenu,
  SidebarSortMenu,
} from "./SidebarSectionDialogs";
import { roveSidebarRows } from "./sidebarRoving";
import {
  reloadSidebarSectionPreferenceForTest,
  setSidebarSectionCollapsed,
  useSidebarSectionsCollapsed,
} from "./sidebarSectionPreference";
import {
  resolveSidebarDrop,
  useSidebarDrag,
  type SidebarDropAction,
} from "./sidebarDnd";
import { useHoverNone } from "@/features/emoji/useHoverNone";
import {
  SIDEBAR_PREFS_SAVE_DEBOUNCE_MS,
  useSidebarPrefs,
} from "./useSidebarPrefs";

// =============================================================================
// BT-5(#1933) 상호작용의 red proof — 별표 · 정렬 · 끌어다 놓기.
//
// 브리프가 이름 댄 것을 그대로 판다:
//   1. 별표 토글 왕복(payload 반영 · 파생 섹션 등장/소멸) · 별표 섹션 순위 고정
//   2. 정렬 전환이 **렌더 순서만** 바꾸고 저장값은 그대로
//   3. 드래그→드롭이 변경 함수를 한 번 부르고, 경계 밖 드롭은 무동작이며,
//      **Esc 가 드래그를 취소**한다 — 전부 실 DOM 이벤트로
//   4. 키보드 동등 경로: 메뉴만으로 같은 최종 배치에 닿는다
//   5. 드래그 기계가 로빙·접기를 깨지 않는다
//
// ## 왜 실 DOM 인가
//
// 이 티켓이 HTML5 네이티브 드래그를 고른 값이 여기 있다(`sidebarDnd.ts` 머리말).
// 판정의 정본이 좌표가 아니라 **대상 요소**라, jsdom 에 `dragover`/`drop` 을 쏘면
// 출하되는 코드가 그대로 답한다. 좌표 기반(라이브러리 포함)이었다면
// `getBoundingClientRect` 가 0을 돌려주는 이 환경에서 계약을 잴 방법이 없다.
//
// ## 하네스와 진짜 사이드바
//
// BT-4 의 시험과 같은 갈래다: 실제 `Sidebar` 를 세우려면 세션·셸 내비·채널 쿼리
// 목이 통째로 필요하고, 그 목들은 이 티켓이 재려는 것과 아무 상관이 없다. 대신
// **같은 훅·같은 파생·같은 컴포넌트**를 쓰고, 그 배선이 `Sidebar.tsx` 의 것과
// 같은지는 아래 「하네스와 출하 배선」이 소스를 읽어 잰다 — 사본이 갈라지는 날을
// 자가 잡는다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const GENERAL = "00000000-0000-7000-8000-000000000201";
const RELEASE = "00000000-0000-7000-8000-000000000202";
const RANDOM = "00000000-0000-7000-8000-000000000203";

const fetchSidebarPrefs = vi.hoisted(() => vi.fn());
const putSidebarPrefs = vi.hoisted(() => vi.fn());

const setChannelNotificationPref = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    setChannelNotificationPref: (ws: string, ch: string, muted: boolean) =>
      setChannelNotificationPref(ws, ch, muted) as Promise<boolean>,
  };
});

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
let navRoot: HTMLElement | null = null;

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
  setChannelNotificationPref.mockReset();
  setChannelNotificationPref.mockResolvedValue(true);
  fetchSidebarPrefs.mockReset();
  fetchSidebarPrefs.mockResolvedValue(emptySidebarPrefs());
  putSidebarPrefs.mockReset();
  putSidebarPrefs.mockImplementation((_ws: string, prefs: SidebarPrefs) =>
    Promise.resolve(prefs)
  );
  reloadSidebarSectionPreferenceForTest(null);
  stubPointerSurface();
});

/** 포인터 하드웨어가 기본. 터치 시험만 뒤집는다(BT-1·BT-4 와 같은 손잡이). */
function stubPointerSurface(hoverNone = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: hoverNone && query.includes("hover: none"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
  navRoot = null;
  reloadSidebarSectionPreferenceForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function channelFixture(id: string, name: string): Channel {
  return { id, workspaceId: WS, kind: "public", name, muted: false };
}

/** 이름은 정렬이 갈리는 조합이다: 라틴 대문자 · 라틴 소문자 · 한글. */
const CHANNELS: Channel[] = [
  channelFixture(GENERAL, "zebra"),
  channelFixture(RELEASE, "가나다"),
  channelFixture(RANDOM, "Apple"),
];
const DMS: Channel[] = [
  { id: "00000000-0000-7000-8000-000000000301", workspaceId: WS, kind: "dm", muted: false },
];

/** 80자 상한에 붙인 한글 이름. 짧은 픽스처는 잘림도 폭도 재지 못한다. */
const LONG_NAME = "출시 준비와 회고 그리고 후속 작업 묶음 ".repeat(4).slice(0, 80);

interface Handle {
  prefs: () => SidebarPrefs;
  create: (name: string) => void;
  move: (channelId: string, sectionId: string | null) => void;
  toggleStar: (channelId: string) => void;
  setSortMode: (mode: typeof SIDEBAR_SORT_ALPHA | typeof SIDEBAR_SORT_MANUAL) => void;
  moveSection: (id: string, delta: -1 | 1) => void;
  dragging: () => boolean;
}
let handle: Handle | null = null;

/**
 * `Sidebar.tsx` 와 **같은 배선**. 다른 것은 세션·채널 쿼리가 목이 아니라 상수인
 * 것뿐이고, 훅·파생·컴포넌트·프롭은 한 벌이다.
 */
function Harness({ enabled = true }: { enabled?: boolean }) {
  const prefs = useSidebarPrefs(WS);
  const derived = useMemo(
    () =>
      deriveSidebarSections({
        prefs: prefs.prefs,
        channels: CHANNELS,
        dms: DMS,
      }),
    [prefs.prefs]
  );
  const onDrop = useCallback(
    (action: SidebarDropAction) => {
      if (action.type === "place") {
        prefs.moveChannel(action.channelId, action.sectionId);
      } else if (action.type === "star") {
        prefs.toggleStar(action.channelId);
      } else {
        prefs.reorderSection(action.sectionId, action.targetId);
      }
    },
    [prefs]
  );
  const touchSurface = useHoverNone();
  const canEdit = prefs.canEdit && enabled && !touchSurface;
  const drag = useSidebarDrag({ enabled: canEdit, onDrop });
  handle = {
    prefs: () => prefs.prefs,
    create: prefs.createSection,
    move: prefs.moveChannel,
    toggleStar: prefs.toggleStar,
    setSortMode: prefs.setSortMode,
    moveSection: prefs.moveSection,
    dragging: () => drag.subject !== null,
  };
  const collapsed = useSidebarSectionsCollapsed();

  const sectionChoices = derived.custom.map((section) => ({
    id: section.id,
    label: section.title,
  }));

  function rowsOf(section: (typeof derived.sections)[number]) {
    const rows = section.channels.map((channel) =>
      createElement(SidebarRow, {
        key: channel.id,
        to: `/c/${channel.id}`,
        icon: null,
        label: channel.name ?? channel.id,
        testId: "channel-item",
        dataAttrs: { "data-channel-id": channel.id },
        dragProps:
          canEdit && channel.kind !== "dm" && section.kind !== "starred"
            ? drag.dragProps({
                kind: "channel",
                channelId: channel.id,
                sectionId: prefs.sectionIdFor(channel.id),
              })
            : undefined,
        // **진짜 행 메뉴**를 단다 (design-review R1 H-1). 이 시험이 재려는 것은
        // 「고른 뒤 캐럿이 어디 있는가」이고, 그 답은 트리거가 행과 함께
        // 언마운트되는 실제 배선에서만 나온다 - 가짜 버튼으로는 결함이 재현되지
        // 않는다.
        wrapLink: (link) =>
          createElement(SidebarRowContextMenu, {
            workspaceId: WS,
            channel,
            title: channel.name ?? channel.id,
            selfMemberId: ME,
            selfRole: "owner",
            readState: null,
            sections: canEdit ? sectionChoices : undefined,
            currentSectionId: prefs.sectionIdFor(channel.id),
            onMoveToSection: canEdit
              ? (sectionId: string | null) =>
                  prefs.moveChannel(channel.id, sectionId)
              : undefined,
            starred: prefs.isStarred(channel.id),
            onToggleStar: canEdit
              ? () => prefs.toggleStar(channel.id)
              : undefined,
            children: link,
          }),
      })
    );
    if (section.kind !== "starred" || !touchSurface) return rows;
    // 터치 표면의 별표 섹션은 자기 사정을 말한다 (R1 M-1). Sidebar.tsx 와 같은
    // 자리·같은 문장이다.
    return [
      ...rows,
      createElement(
        "li",
        { key: "starred-touch-hint", className: "px-2 py-1 text-meta text-ink-muted" },
        SIDEBAR_STARRED_TOUCH_HINT
      ),
    ];
  }

  return createElement(
    "div",
    {
      "data-testid": "nav-root",
      ref: (node: HTMLDivElement | null): void => {
        navRoot = node;
      },
      onKeyDown: (event: ReactKeyboardEvent) => {
        roveSidebarRows(navRoot, event);
      },
    },
    createElement(
      "nav",
      null,
      derived.sections.map((section) =>
        createElement(SidebarSection, {
          key: section.id,
          title: section.title,
          sectionId: section.id,
          collapsed: collapsed[section.id] === true,
          onCollapsedChange: (next: boolean) =>
            setSidebarSectionCollapsed(section.id, next),
          dropProps:
            section.kind === "dms"
              ? undefined
              : drag.dropProps({
                  kind: section.kind === "custom" ? "custom" : section.kind,
                  sectionId: section.kind === "custom" ? section.id : null,
                }),
          headerDragProps:
            canEdit && section.kind === "custom"
              ? drag.dragProps({ kind: "section", sectionId: section.id })
              : undefined,
          action:
            canEdit && section.kind === "custom"
              ? createElement(SidebarSectionMenu, {
                  sectionId: section.id,
                  title: section.title,
                  order: {
                    canUp: prefs.canMoveSection(section.id, -1),
                    canDown: prefs.canMoveSection(section.id, 1),
                    onMove: (delta: -1 | 1) =>
                      prefs.moveSection(section.id, delta),
                  },
                  onOpenChange: () => undefined,
                })
              : canEdit && section.kind === "channels"
                ? createElement(SidebarSortMenu, {
                    mode: prefs.sortMode,
                    onChange: prefs.setSortMode,
                    onOpenChange: () => undefined,
                  })
                : undefined,
          children: rowsOf(section),
        })
      )
    )
  );
}

async function mount(props: { enabled?: boolean } = {}) {
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
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      if (vi.isFakeTimers()) vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
  }
  return mountedHost;
}

function sectionIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-testid^='sidebar-section-']")
  )
    .filter((el) => !el.dataset.testid?.endsWith("-header"))
    .map((el) => (el.dataset.testid ?? "").replace("sidebar-section-", ""));
}

function sectionEl(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid='sidebar-section-${id}']`
  );
  if (!found) throw new Error(`섹션이 없다: ${id}`);
  return found;
}

function headerEl(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid='sidebar-section-${id}-header']`
  );
  if (!found) throw new Error(`머리글이 없다: ${id}`);
  return found;
}

/**
 * 헤더 위에 포인터를 올린다 — 호버 클러스터를 마운트시키는 그 신호.
 *
 * React 의 `onMouseEnter` 는 네이티브 `mouseenter` 가 아니라 `mouseover` 에서
 * 합성된다(EnterLeaveEventPlugin). `relatedTarget` 이 없으면 「밖에서 들어왔다」로
 * 읽히므로 그것이 곧 진입이다. 실제 브라우저가 하는 것과 같은 경로다.
 */
function hoverHeader(sectionId: string): void {
  act(() => {
    headerEl(sectionId).dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true })
    );
  });
}

/**
 * 섹션 ⋮ 를 **키보드로** 연다. Radix 의 트리거는 포인터에서 `pointerdown` 으로
 * 열리는데 jsdom 에는 `PointerEvent` 가 없고, 어차피 이 파일이 재려는 것은
 * 「끌지 않고도 같은 결과에 닿는가」다 - 그 경로가 곧 Enter 다.
 */
function openSectionMenu(sectionId: string): void {
  hoverHeader(sectionId);
  act(() => {
    menuItem(`section-menu-${sectionId}`).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
  });
}

/** 정렬 문. 기본 「채널」 머리글에 살고 섹션 ⋮ 와 다른 컨트롤이다(R1 M-2). */
function openSortMenu(): void {
  hoverHeader("channels");
  act(() => {
    menuItem("sidebar-sort-menu").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
  });
}

/** 행 우클릭. 브라우저가 쏘는 것과 같은 이벤트다. */
function rightClick(row: HTMLElement): void {
  act(() => {
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 16,
        clientY: 16,
      })
    );
  });
}

/** rAF 한 프레임. 포커스 인계가 서는 자리다(`sidebarRowFocus.ts`). */
function nextFrame(): void {
  act(() => {
    vi.advanceTimersByTime(32);
  });
}

function menuItem(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`메뉴 항목이 없다: ${testId}`);
  return found;
}

function channelsIn(sectionId: string): string[] {
  return Array.from(
    sectionEl(sectionId).querySelectorAll<HTMLElement>("[data-channel-id]")
  ).map((el) => el.dataset.channelId ?? "");
}

function rowEl(channelId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-channel-id='${channelId}']`
  );
  if (!found) throw new Error(`행이 없다: ${channelId}`);
  return found;
}

/**
 * 브라우저가 쏘는 것과 같은 이름의 이벤트. `dataTransfer` 는 싣지 않는다 —
 * jsdom 에 그 생성자가 없고, 출하 코드가 그 사실 위에서 동작하는지가 곧
 * 이 시험의 절반이다(`sidebarDnd.ts` 의 옵셔널 체이닝).
 */
function fireDrag(
  target: HTMLElement,
  type: "dragstart" | "dragover" | "dragleave" | "drop" | "dragend"
): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  let defaultPrevented = false;
  act(() => {
    target.dispatchEvent(event);
    defaultPrevented = event.defaultPrevented;
  });
  return defaultPrevented;
}

async function settleSave() {
  await act(async () => {
    vi.advanceTimersByTime(SIDEBAR_PREFS_SAVE_DEBOUNCE_MS);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function withSection(name = LONG_NAME) {
  await act(async () => handle?.create(name));
}

// =============================================================================

describe("red proof 1 — 별표", () => {
  it("토글이 payload 에 닿고 파생 섹션이 등장·소멸한다", async () => {
    vi.useFakeTimers();
    await mount();
    expect(sectionIds()).toEqual(["channels", "dms"]);

    await act(async () => handle?.toggleStar(RELEASE));
    // 파생 섹션이 **맨 위**에 등장한다.
    expect(sectionIds()).toEqual(["starred", "channels", "dms"]);
    expect(channelsIn("starred")).toEqual([RELEASE]);
    // 그리고 원래 목록에서는 한 번만 그려진다.
    expect(channelsIn("channels")).toEqual([GENERAL, RANDOM]);

    await settleSave();
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    expect(
      (putSidebarPrefs.mock.calls[0][1] as SidebarPrefs).starredChannelIds
    ).toEqual([RELEASE]);

    await act(async () => handle?.toggleStar(RELEASE));
    expect(sectionIds()).toEqual(["channels", "dms"]);
    expect(channelsIn("channels")).toEqual([GENERAL, RELEASE, RANDOM]);
  });

  it("별표를 붙여도 배치는 그대로고, 떼면 그 자리로 돌아온다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection();
    await act(async () => handle?.move(RELEASE, "sec-1"));
    expect(channelsIn("sec-1")).toEqual([RELEASE]);

    await act(async () => handle?.toggleStar(RELEASE));
    expect(channelsIn("starred")).toEqual([RELEASE]);
    expect(channelsIn("sec-1")).toEqual([]);
    // **payload 의 배치는 살아 있다** — 별표는 표식이지 이사가 아니다.
    expect(handle?.prefs().sections[0].channelIds).toEqual([RELEASE]);

    await act(async () => handle?.toggleStar(RELEASE));
    expect(channelsIn("sec-1")).toEqual([RELEASE]);
  });

  it("별표 섹션은 커스텀 섹션이 여럿이어도 맨 위를 지킨다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection("가");
    await withSection("나");
    await act(async () => handle?.toggleStar(GENERAL));
    await act(async () => handle?.toggleStar(RANDOM));
    expect(sectionIds()).toEqual(["starred", "channels", "sec-1", "sec-2", "dms"]);
    expect(channelsIn("starred")).toEqual([GENERAL, RANDOM]);
  });
});

describe("red proof 2 — 정렬", () => {
  it("렌더 순서만 바뀌고 저장된 배치는 그대로다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection();
    await act(async () => handle?.move(GENERAL, "sec-1"));
    await act(async () => handle?.move(RANDOM, "sec-1"));
    expect(channelsIn("sec-1")).toEqual([GENERAL, RANDOM]);

    await act(async () => handle?.setSortMode(SIDEBAR_SORT_ALPHA));
    // 「가나다」: 화면이 다시 선다.
    expect(channelsIn("sec-1")).toEqual([RANDOM, GENERAL]);
    // 그런데 payload 의 차례는 사람이 만든 그대로다.
    expect(handle?.prefs().sections[0].channelIds).toEqual([GENERAL, RANDOM]);

    await act(async () => handle?.setSortMode(SIDEBAR_SORT_MANUAL));
    expect(channelsIn("sec-1")).toEqual([GENERAL, RANDOM]);
    await settleSave();
    // 마지막 상태 하나만 나가고, 그 상태에는 정렬 칸이 없다(기본값은 적지 않는다).
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    const saved = putSidebarPrefs.mock.calls[0][1] as SidebarPrefs;
    expect(saved.sectionSort).toBeUndefined();
    expect(saved.sections[0].channelIds).toEqual([GENERAL, RANDOM]);
  });

  it("정렬의 문은 기본 「채널」 헤더 하나이고, 지금 값이 체크로 들린다", async () => {
    vi.useFakeTimers();
    const host = await mount();
    // 커스텀 섹션이 하나도 없어도 서 있다 — 섹션을 만들어야 열리는 설정이 아니다.
    hoverHeader("channels");
    // 문이 자기 글리프·자기 이름을 갖는다 (R1 M-2): 섹션 ⋮ 가 아니다.
    expect(host.querySelector('[data-testid="sidebar-sort-menu"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="section-menu-channels"]')).toBeNull();
    openSortMenu();
    expect(menuItem("sidebar-sort-label").textContent).toBe("채널 정렬");
    const alpha = menuItem("sidebar-sort-alpha");
    const manual = menuItem("sidebar-sort-manual");
    expect(manual.getAttribute("aria-checked")).toBe("true");
    expect(alpha.getAttribute("aria-checked")).toBe("false");

    act(() => alpha.click());
    expect(channelsIn("channels")).toEqual([RELEASE, RANDOM, GENERAL]);
  });
});

describe("red proof 3 — 끌어다 놓기 (실 DOM)", () => {
  it("드래그 → 드롭이 배치를 한 번 바꾼다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection();

    fireDrag(rowEl(RELEASE), "dragstart");
    expect(handle?.dragging()).toBe(true);
    // 받는 자리는 `preventDefault` 로 「여기는 받는다」고 답한다.
    expect(fireDrag(sectionEl("sec-1"), "dragover")).toBe(true);
    expect(sectionEl("sec-1").hasAttribute("data-drop-target")).toBe(true);

    fireDrag(sectionEl("sec-1"), "drop");
    expect(handle?.dragging()).toBe(false);
    expect(channelsIn("sec-1")).toEqual([RELEASE]);
    expect(channelsIn("channels")).toEqual([GENERAL, RANDOM]);

    await settleSave();
    // **한 번**이다. 드롭이 변경 함수를 두 번 부르면 여기서 두 번 나간다.
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    expect(
      (putSidebarPrefs.mock.calls[0][1] as SidebarPrefs).sections[0].channelIds
    ).toEqual([RELEASE]);
  });

  it("경계 밖 드롭은 무동작이다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection();
    // 먼저 정착시킨다: 「무동작」의 자는 payload 만이 아니라 **나간 PUT 의 수**다.
    // 디바운스가 살아 있는 채로 재면 헛나간 쓰기가 앞의 저장에 흡수돼 보이지
    // 않는다.
    await settleSave();
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    const before = handle?.prefs();

    fireDrag(rowEl(RELEASE), "dragstart");
    // DM 섹션은 구역이 아니다 — DM 은 커스텀 섹션에 들어가지 않는다(D4).
    expect(fireDrag(sectionEl("dms"), "dragover")).toBe(false);
    expect(sectionEl("dms").hasAttribute("data-drop-target")).toBe(false);
    fireDrag(sectionEl("dms"), "drop");
    expect(handle?.prefs()).toEqual(before);
    await settleSave();
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);

    // 이미 있는 자리에 다시 떨어뜨리는 것도 아무 일이 아니다 — 표지도 서지 않고,
    // 저장도 나가지 않는다(payload 상 「뺐다가 맨 뒤에 붙이기」가 되면 안 된다).
    fireDrag(rowEl(RELEASE), "dragstart");
    expect(fireDrag(sectionEl("channels"), "dragover")).toBe(false);
    fireDrag(sectionEl("channels"), "drop");
    expect(handle?.prefs()).toEqual(before);
    await settleSave();
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
  });

  it("Esc 가 드래그를 취소한다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection();
    const before = handle?.prefs();

    fireDrag(rowEl(RELEASE), "dragstart");
    fireDrag(sectionEl("sec-1"), "dragover");
    expect(sectionEl("sec-1").hasAttribute("data-drop-target")).toBe(true);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(handle?.dragging()).toBe(false);
    expect(sectionEl("sec-1").hasAttribute("data-drop-target")).toBe(false);

    // 취소한 뒤의 드롭은 아무 일도 아니다 — 들고 있던 것이 없다.
    fireDrag(sectionEl("sec-1"), "drop");
    expect(handle?.prefs()).toEqual(before);
  });

  it("별표 섹션은 받고, 그 안의 행은 끌리지 않는다", async () => {
    vi.useFakeTimers();
    await mount();
    fireDrag(rowEl(RELEASE), "dragstart");
    // 별표 섹션은 비어 있는 동안 렌더되지 않는다. 문은 행 메뉴다.
    expect(sectionIds()).not.toContain("starred");
    fireDrag(sectionEl("channels"), "dragend");

    await act(async () => handle?.toggleStar(GENERAL));
    fireDrag(rowEl(RELEASE), "dragstart");
    expect(fireDrag(sectionEl("starred"), "dragover")).toBe(true);
    fireDrag(sectionEl("starred"), "drop");
    expect(channelsIn("starred")).toEqual([GENERAL, RELEASE]);

    // 별표 섹션의 행에는 손잡이가 없다: 떨어뜨려도 화면에서 아무 일이 없으므로.
    expect(rowEl(GENERAL).getAttribute("draggable")).toBeNull();
    expect(rowEl(RANDOM).getAttribute("draggable")).toBe("true");
  });

  it("섹션 머리글 드래그가 섹션 차례를 바꾼다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection("가");
    await withSection("나");
    await withSection("다");
    expect(sectionIds()).toEqual([
      "channels",
      "sec-1",
      "sec-2",
      "sec-3",
      "dms",
    ]);

    fireDrag(headerEl("sec-3"), "dragstart");
    // 기본 섹션은 자리를 내주지 않는다 — 차례가 고정이다.
    expect(fireDrag(sectionEl("channels"), "dragover")).toBe(false);
    expect(fireDrag(sectionEl("sec-1"), "dragover")).toBe(true);
    fireDrag(sectionEl("sec-1"), "drop");
    expect(sectionIds()).toEqual([
      "channels",
      "sec-3",
      "sec-1",
      "sec-2",
      "dms",
    ]);
  });

  it("문이 닫힌 표면에는 손잡이도 구역도 없다", async () => {
    vi.useFakeTimers();
    await mount({ enabled: false });
    expect(rowEl(RELEASE).getAttribute("draggable")).toBeNull();
    fireDrag(rowEl(RELEASE), "dragstart");
    expect(handle?.dragging()).toBe(false);
    expect(fireDrag(sectionEl("channels"), "dragover")).toBe(false);
  });

  it("드롭 계산의 판정 넷이 전부 자기 답을 갖는다", () => {
    // 사보타지의 과녁. 이 함수의 한 줄이 사라지면 위 시험들이 함께 붉어진다.
    expect(
      resolveSidebarDrop(
        { kind: "channel", channelId: GENERAL, sectionId: null },
        { kind: "starred", sectionId: null }
      )
    ).toEqual({ type: "star", channelId: GENERAL });
    expect(
      resolveSidebarDrop(
        { kind: "channel", channelId: GENERAL, sectionId: null },
        { kind: "custom", sectionId: "sec-1" }
      )
    ).toEqual({ type: "place", channelId: GENERAL, sectionId: "sec-1" });
    expect(
      resolveSidebarDrop(
        { kind: "channel", channelId: GENERAL, sectionId: "sec-1" },
        { kind: "custom", sectionId: "sec-1" }
      )
    ).toBeNull();
    expect(
      resolveSidebarDrop(
        { kind: "section", sectionId: "sec-2" },
        { kind: "custom", sectionId: "sec-1" }
      )
    ).toEqual({ type: "reorder", sectionId: "sec-2", targetId: "sec-1" });
    expect(
      resolveSidebarDrop(
        { kind: "section", sectionId: "sec-2" },
        { kind: "starred", sectionId: null }
      )
    ).toBeNull();
  });
});

describe("red proof 4 — 키보드가 같은 결과에 닿는다", () => {
  it("⋮ 「위로」만으로 드롭과 같은 최종 배치에 도달한다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection("가");
    await withSection("나");
    await withSection("다");

    // 포인터 경로: sec-3 을 sec-1 자리로 끌어다 놓는다.
    fireDrag(headerEl("sec-3"), "dragstart");
    fireDrag(sectionEl("sec-1"), "drop");
    const byDrop = handle?.prefs();
    expect(sectionIds()).toEqual([
      "channels",
      "sec-3",
      "sec-1",
      "sec-2",
      "dms",
    ]);

    // 되돌린 뒤 키보드 경로: 메뉴의 「위로」 두 번.
    await act(async () => handle?.moveSection("sec-3", 1));
    await act(async () => handle?.moveSection("sec-3", 1));
    expect(sectionIds()).toEqual([
      "channels",
      "sec-1",
      "sec-2",
      "sec-3",
      "dms",
    ]);

    for (let i = 0; i < 2; i += 1) {
      openSectionMenu("sec-3");
      act(() => menuItem("section-menu-sec-3-up").click());
    }

    expect(sectionIds()).toEqual([
      "channels",
      "sec-3",
      "sec-1",
      "sec-2",
      "dms",
    ]);
    expect(handle?.prefs().sections).toEqual(byDrop?.sections);
  });

  it("끝에 닿은 방향은 비활성이다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection("가");
    await withSection("나");
    openSectionMenu("sec-1");
    expect(menuItem("section-menu-sec-1-up").hasAttribute("data-disabled")).toBe(
      true
    );
    expect(
      menuItem("section-menu-sec-1-down").hasAttribute("data-disabled")
    ).toBe(false);
  });
});

describe("red proof 5 — 드래그가 기존 기계를 깨지 않는다", () => {
  it("드래그 중에도 ↑/↓ 로빙이 그대로 돈다", async () => {
    vi.useFakeTimers();
    await mount();
    const rows = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-row]"));
    const before = rows().length;

    rowEl(GENERAL).focus();
    fireDrag(rowEl(GENERAL), "dragstart");
    expect(handle?.dragging()).toBe(true);
    // 정거장 수가 늘지 않았다: 손잡이는 링크 **자신**에 붙는다.
    expect(rows().length).toBe(before);

    let prevented = false;
    act(() => {
      prevented = roveSidebarRows(navRoot, {
        key: "ArrowDown",
        target: rowEl(GENERAL),
        preventDefault: () => undefined,
      });
    });
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(rowEl(RELEASE));
  });

  it("드래그 중에도 접기가 그대로 동작한다", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection();
    fireDrag(rowEl(RELEASE), "dragstart");
    act(() => {
      document
        .querySelector<HTMLElement>('[data-testid="section-collapse-sec-1"]')
        ?.click();
    });
    expect(sectionEl("sec-1").hasAttribute("data-collapsed")).toBe(true);
    // 접힌 섹션도 여전히 받는다 — 행이 없다고 배치가 뜻을 잃지는 않는다.
    expect(fireDrag(sectionEl("sec-1"), "dragover")).toBe(true);
    fireDrag(sectionEl("sec-1"), "drop");
    expect(handle?.prefs().sections[0].channelIds).toEqual([RELEASE]);
  });
});

describe("R1 H-1 — 행을 옮기는 액션은 캐럿을 데리고 간다", () => {
  function menuRow(testKey: string): HTMLElement {
    const found = document.querySelector<HTMLElement>(
      `[data-testid="channel-row-${testKey}"]`
    );
    if (!found) throw new Error(`행 메뉴 항목이 없다: ${testKey}`);
    return found;
  }

  it("별표를 붙이면 옮겨간 그 행이 캐럿을 받는다", async () => {
    vi.useFakeTimers();
    await mount();
    const row = rowEl(RELEASE);
    row.focus();
    rightClick(row);
    act(() => menuRow("star").click());
    // 트리거가 행과 함께 언마운트되므로 이 순간 캐럿은 갈 곳을 잃는다.
    nextFrame();

    // 행은 「별표」 섹션에 다시 섰고, 캐럿이 그 행 위에 있다.
    expect(channelsIn("starred")).toEqual([RELEASE]);
    expect(document.activeElement).toBe(rowEl(RELEASE));
    expect(sectionEl("starred").contains(document.activeElement)).toBe(true);
  });

  it("별표를 떼도 같다 — 두 방향 모두", async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => handle?.toggleStar(RELEASE));
    const starredRow = rowEl(RELEASE);
    starredRow.focus();
    rightClick(starredRow);
    act(() => menuRow("star").click());
    nextFrame();

    expect(sectionIds()).not.toContain("starred");
    expect(document.activeElement).toBe(rowEl(RELEASE));
    expect(sectionEl("channels").contains(document.activeElement)).toBe(true);
  });

  it("「섹션으로 이동」도 함께 닫힌다 (BT-4 승계 구멍)", async () => {
    vi.useFakeTimers();
    await mount();
    await withSection();
    const row = rowEl(RELEASE);
    row.focus();
    rightClick(row);
    act(() => {
      document
        .querySelector<HTMLElement>('[data-testid="channel-row-section-sec-1"]')
        ?.click();
    });
    nextFrame();

    expect(channelsIn("sec-1")).toEqual([RELEASE]);
    expect(document.activeElement).toBe(rowEl(RELEASE));
    expect(sectionEl("sec-1").contains(document.activeElement)).toBe(true);
  });

  it("대조군 — 행을 옮기지 않는 「알림」은 캐럿을 건드리지 않는다", async () => {
    vi.useFakeTimers();
    await mount();
    const row = rowEl(RELEASE);
    row.focus();
    rightClick(row);
    const before = document.activeElement;
    act(() => menuRow("mute-toggle").click());
    nextFrame();

    // 메뉴가 열린 채로 남고(왕복이 그 자리에서 실패를 말해야 한다) 캐럿도
    // 그대로다 - 인계는 **옮기는 액션에만** 걸린다.
    expect(document.activeElement).toBe(before);
    expect(rowEl(RELEASE).parentElement).not.toBeNull();
  });

  it("옮긴 뒤에도 ↑/↓ 로빙이 새 이웃 사이를 걷는다", async () => {
    vi.useFakeTimers();
    await mount();
    const row = rowEl(GENERAL);
    row.focus();
    rightClick(row);
    act(() => menuRow("star").click());
    nextFrame();
    await act(async () => handle?.toggleStar(RANDOM));

    expect(channelsIn("starred")).toEqual([GENERAL, RANDOM]);
    let moved = false;
    act(() => {
      moved = roveSidebarRows(navRoot, {
        key: "ArrowDown",
        target: rowEl(GENERAL),
        preventDefault: () => undefined,
      });
    });
    expect(moved).toBe(true);
    expect(document.activeElement).toBe(rowEl(RANDOM));
  });
});

describe("R1 M-1 — 터치의 별표 섹션이 자기 사정을 말한다", () => {
  it("떼는 문이 없는 표면에서 그 사실을 문장으로 든다", async () => {
    vi.useFakeTimers();
    stubPointerSurface(true);
    fetchSidebarPrefs.mockResolvedValue({
      ...emptySidebarPrefs(),
      starredChannelIds: [RELEASE],
    } satisfies SidebarPrefs);
    await mount();

    // 로밍해 온 별표는 그려진다 - 읽는 것은 언제나 참이다.
    expect(channelsIn("starred")).toEqual([RELEASE]);
    // 그런데 손잡이도 문도 없다.
    expect(rowEl(RELEASE).getAttribute("draggable")).toBeNull();
    expect(
      sectionEl("starred").querySelectorAll("[data-section-action]").length
    ).toBe(0);
    // 그래서 사정을 말한다.
    expect(sectionEl("starred").textContent).toContain(
      SIDEBAR_STARRED_TOUCH_HINT
    );
  });

  it("포인터 표면에서는 그 문장이 서지 않는다", async () => {
    vi.useFakeTimers();
    fetchSidebarPrefs.mockResolvedValue({
      ...emptySidebarPrefs(),
      starredChannelIds: [RELEASE],
    } satisfies SidebarPrefs);
    await mount();
    expect(sectionEl("starred").textContent).not.toContain(
      SIDEBAR_STARRED_TOUCH_HINT
    );
  });
});

describe("R1 M-4 — 2초 창이 새로고침을 삼키지 않는다", () => {
  it("탭이 숨으면 남은 편집이 즉시 나간다", async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => handle?.toggleStar(RELEASE));
    await act(async () => handle?.setSortMode(SIDEBAR_SORT_ALPHA));
    // 아직 디바운스 창 안이다.
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(putSidebarPrefs).not.toHaveBeenCalled();

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    const saved = putSidebarPrefs.mock.calls[0][1] as SidebarPrefs;
    expect(saved.starredChannelIds).toEqual([RELEASE]);
    expect(saved.sectionSort).toBe(SIDEBAR_SORT_ALPHA);

    // 남은 타이머가 같은 payload 를 한 번 더 보내지 않는다.
    await act(async () => {
      vi.advanceTimersByTime(SIDEBAR_PREFS_SAVE_DEBOUNCE_MS);
    });
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("탭을 떠나는 신호(pagehide)도 같은 문을 쓴다", async () => {
    vi.useFakeTimers();
    await mount();
    await act(async () => handle?.toggleStar(GENERAL));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(putSidebarPrefs).toHaveBeenCalledTimes(1);
    expect(
      (putSidebarPrefs.mock.calls[0][1] as SidebarPrefs).starredChannelIds
    ).toEqual([GENERAL]);
  });

  it("보낼 것이 없으면 아무것도 나가지 않는다", async () => {
    vi.useFakeTimers();
    await mount();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(putSidebarPrefs).not.toHaveBeenCalled();
  });
});

describe("하네스와 출하 배선", () => {
  // jsdom 아래에서는 `new URL(…, import.meta.url)` 이 jsdom 의 URL 이라
  // `fileURLToPath` 가 받지 않는다. 문자열을 먼저 경로로 바꾸고 이어 붙인다.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "Sidebar.tsx"),
    "utf8"
  );

  it("Sidebar 가 같은 훅·같은 프롭으로 배선돼 있다", () => {
    // 이 하네스가 출하되는 화면과 갈라지는 날을 자가 잡는다. 재는 것은 **배선**
    // 이지 모양이 아니다: 어느 훅을 부르는가, 어느 프롭으로 넘기는가.
    expect(source).toContain("useSidebarDrag({");
    expect(source).toContain("enabled: canEditSections");
    expect(source).toContain('drag.dropProps({ kind: "starred", sectionId: null })');
    expect(source).toContain('drag.dropProps({ kind: "channels", sectionId: null })');
    expect(source).toContain('kind: "custom",');
    expect(source).toContain('drag.dragProps({ kind: "section", sectionId: section.id })');
    // DM 섹션은 구역을 이지 않는다.
    expect(source).not.toMatch(/dmSection[\s\S]{0,400}dropProps/);
  });

  it("저장은 전부 훅의 변경 함수를 지나간다", () => {
    // 새 쓰기 경로가 생기면 부트스트랩 게이트·상한·디바운스·롤백이 함께
    // 우회된다(ADR-0177 D2 / BT-4 B-1).
    expect(source).toContain("sidebarPrefs.toggleStar(");
    expect(source).toContain("sidebarPrefs.reorderSection(");
    expect(source).toContain("sidebarPrefs.moveSection(");
    expect(source).toContain("sidebarPrefs.setSortMode");
    // R1 M-2: 정렬은 자기 문에 산다(섹션 ⋮ 가 아니다).
    expect(source).toContain("<SidebarSortMenu");
    expect(source).not.toMatch(/SidebarSectionMenu[\s\S]{0,200}sort=\{/);
    // R1 M-1: 터치의 별표 섹션이 사정을 말한다.
    expect(source).toContain("SIDEBAR_STARRED_TOUCH_HINT");
    expect(source).not.toContain("putSidebarPrefs");
  });
});
