// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { MemoryItemEvent } from "@momo/core/features/memory/model";
import {
  CLEANUP_NOTE,
  HISTORY_CLEANUP_NOTE,
  REVERT_CONFLICT_MESSAGE,
  REVERT_FAILED_MESSAGE,
  REVERT_FORBIDDEN_MESSAGE,
  REVERT_GONE_MESSAGE,
  REVERT_GUEST_READONLY,
  REVERT_UNSUPPORTED_MESSAGE,
  TIMELINE_EMPTY_HEADLINE,
  TIMELINE_LINKS_ERROR,
  TIMELINE_LOAD_ERROR,
} from "@momo/core/features/memory/timeline";
import { MemoryBrowserRoute } from "./MemoryBrowserRoute";
import { CH, ME, WS, byTestId, click, item, mount, settings, unmount, waitUntil } from "./memoryTestKit";

const listMemoryItems = vi.hoisted(() => vi.fn());
const getMemoryItem = vi.hoisted(() => vi.fn());
const getMemoryItemEvents = vi.hoisted(() => vi.fn());
const revertMemoryConsolidation = vi.hoisted(() => vi.fn());
const getMemorySettings = vi.hoisted(() => vi.fn());
const listChannels = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    listMemoryItems: (...a: unknown[]) => listMemoryItems(...a) as unknown,
    getMemoryItem: (...a: unknown[]) => getMemoryItem(...a) as unknown,
    getMemoryItemEvents: (...a: unknown[]) => getMemoryItemEvents(...a) as unknown,
    revertMemoryConsolidation: (...a: unknown[]) => revertMemoryConsolidation(...a) as unknown,
    getMemorySettings: (...a: unknown[]) => getMemorySettings(...a) as unknown,
  };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, listChannels: (...a: unknown[]) => listChannels(...a) as unknown };
});

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-03T10:00:00+09:00");
const OLD = "00000000-0000-7000-8000-000000000710";
const NEW = "00000000-0000-7000-8000-000000000711";
const MERGED = "00000000-0000-7000-8000-000000000712";
const DECAYED = "00000000-0000-7000-8000-000000000713";
const CLOSE_EVENT = "00000000-0000-7000-8000-000000000910";
const MERGE_EVENT = "00000000-0000-7000-8000-000000000911";
const DECAY_EVENT = "00000000-0000-7000-8000-000000000912";

const OLD_ITEM = item({
  id: OLD,
  subjectKey: "결제 재시도 큐",
  body: "재시도 큐는 두 배로 늘려요.",
  validFromMs: T0,
  validToMs: T0 + 6 * DAY,
});
const NEW_ITEM = item({
  id: NEW,
  subjectKey: "결제 재시도 큐",
  body: "재시도 큐는 세 배로 늘려요.",
  validFromMs: T0 + 6 * DAY,
});
const MERGED_ITEM = item({
  id: MERGED,
  subjectKey: "배포 요일",
  body: "배포는 목요일 오전이에요.",
  validFromMs: T0 + DAY,
  retiredAtMs: T0 + 2 * DAY,
  retiredReason: "merged",
});
const DECAYED_ITEM = item({
  id: DECAYED,
  body: "임시 워커 한도는 512MB예요.",
  validFromMs: T0 + 2 * DAY,
  retiredAtMs: T0 + 9 * DAY,
  retiredReason: "decayed",
});

const CLOSE: MemoryItemEvent = {
  id: CLOSE_EVENT,
  action: "superseded",
  detail: { reason: "contradiction", superseded_by: NEW },
  createdAtMs: T0 + 6 * DAY,
};
const MERGE: MemoryItemEvent = {
  id: MERGE_EVENT,
  action: "merged",
  detail: { into: "00000000-0000-7000-8000-000000000799" },
  createdAtMs: T0 + 2 * DAY,
};
const DECAY: MemoryItemEvent = {
  id: DECAY_EVENT,
  action: "retired",
  detail: { reason: "decayed" },
  createdAtMs: T0 + 9 * DAY,
};

const EVENTS: Record<string, MemoryItemEvent[]> = {
  [OLD]: [CLOSE],
  [NEW]: [],
  [MERGED]: [MERGE],
  [DECAYED]: [DECAY],
};

beforeEach(() => {
  listMemoryItems.mockReset().mockResolvedValue({
    items: [NEW_ITEM, DECAYED_ITEM, MERGED_ITEM, OLD_ITEM],
  });
  getMemoryItem.mockReset().mockImplementation((_ws: string, id: string) =>
    Promise.resolve({
      item: [OLD_ITEM, NEW_ITEM, MERGED_ITEM, DECAYED_ITEM].find((row) => row.id === id) ?? NEW_ITEM,
      evidence: [],
    })
  );
  getMemoryItemEvents
    .mockReset()
    .mockImplementation((_ws: string, id: string) => Promise.resolve(EVENTS[id] ?? []));
  revertMemoryConsolidation
    .mockReset()
    .mockResolvedValue({ reverted: "superseded", itemId: OLD });
  getMemorySettings.mockReset().mockResolvedValue(settings());
  listChannels.mockReset().mockResolvedValue([
    { id: CH, workspaceId: WS, kind: "public", name: "결제-개발", muted: false },
  ]);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function render(
  options: { role?: "member" | "guest" | "admin"; route?: string; mobile?: boolean } = {}
) {
  const view = mount(createElement(MemoryBrowserRoute), {
    role: options.role ?? "member",
    route: options.route ?? "/memory?view=timeline",
    mobile: options.mobile === true,
  });
  // Settle on a state, not a flush count (#3236): the list query has resolved into a
  // terminal view. Tests that assert on later async state (event links, detail pane) wait
  // for that exact DOM condition themselves.
  await waitUntil(
    () =>
      view.host.querySelector(
        '[data-testid="memory-timeline-entry"], [data-testid="memory-timeline-empty"], [data-testid="memory-timeline-error"]'
      ) !== null,
    "timeline settled"
  );
  return view;
}

const entries = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="memory-timeline-entry"]')];
const dialog = () =>
  document.body.querySelector<HTMLElement>('[data-testid="memory-revert-dialog"]');
const dialogButton = (id: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const dialogOpen = () => dialog()?.getAttribute("data-state") === "open";
// The detail pane and its event history load after the list: wait for the revert control
// (or the given history marker) instead of assuming how many ticks that takes.
const historyReady = (host: HTMLElement, id = "memory-detail-event") => () => byTestId(host, id) !== null;

describe("결정 타임라인", () => {
  it("결정만 시간순으로 묶어 그리고 종류·상태로 좁힌 질의를 보낸다", async () => {
    const { host } = await render();
    expect(listMemoryItems).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ kind: "decision", status: "all", limit: 100 })
    );
    const groups = host.querySelectorAll('[data-testid="memory-timeline-group"]');
    expect(groups).toHaveLength(3);
    // 묶음 안에서는 오래된 결정이 위다.
    const queue = [...groups].find((group) => group.textContent?.includes("결제 재시도 큐"));
    const rows = queue?.querySelectorAll('[data-testid="memory-timeline-entry"]') ?? [];
    expect([...rows].map((row) => row.getAttribute("data-item-id"))).toEqual([OLD, NEW]);
  });

  it("지금 유효한 결정과 닫힌 결정을 상태와 유효 기간으로 구분한다", async () => {
    const { host } = await render();
    const byItem = (id: string) => entries(host).find((row) => row.dataset.itemId === id);
    expect(byItem(NEW)?.dataset.state).toBe("current");
    expect(byItem(NEW)?.textContent).toContain("지금 유효해요");
    expect(byItem(NEW)?.textContent).toContain("부터 지금까지");
    expect(byItem(OLD)?.dataset.state).toBe("closed");
    expect(byItem(OLD)?.textContent).toContain("기간이 닫혔어요");
    expect(byItem(OLD)?.textContent).toContain("9월 3일 ~ 9월 9일");
    expect(byItem(MERGED)?.dataset.state).toBe("merged");
    expect(byItem(DECAYED)?.dataset.state).toBe("decayed");
  });

  it("무엇이 무엇을 바꿨는지는 옛 결정의 원장 사건에서 읽고 링크로 이어 준다", async () => {
    const { host } = await render();
    const old = entries(host).find((row) => row.dataset.itemId === OLD);
    await waitUntil(
      () =>
        byTestId(old as HTMLElement, "memory-timeline-open-replacement") !== null &&
        byTestId(entries(host).find((row) => row.dataset.itemId === NEW) as HTMLElement, "memory-timeline-replaces") !== null,
      "event links drawn"
    );
    expect(byTestId(old as HTMLElement, "memory-timeline-replaced")?.textContent).toContain(
      "다른 결정으로 바뀌었어요 (9월 9일)"
    );
    const now = entries(host).find((row) => row.dataset.itemId === NEW);
    expect(byTestId(now as HTMLElement, "memory-timeline-replaces")?.textContent).toContain(
      "이전 결정 1개를 바꿨어요"
    );
    click(byTestId(old as HTMLElement, "memory-timeline-open-replacement"));
    await waitUntil(
      () => byTestId(host, "memory-detail")?.getAttribute("data-item-id") === NEW,
      "detail opened on the replacing decision"
    );
    expect(byTestId(host, "memory-detail")?.getAttribute("data-item-id")).toBe(NEW);
  });

  it("합쳐진 결정은 합쳐진 곳을 가리킨다", async () => {
    const { host } = await render();
    const merged = entries(host).find((row) => row.dataset.itemId === MERGED) as HTMLElement;
    await waitUntil(() => byTestId(merged, "memory-timeline-open-winner") !== null, "merge link drawn");
    expect(byTestId(merged, "memory-timeline-merged")?.textContent).toContain("합쳐졌어요");
    expect(byTestId(merged, "memory-timeline-open-winner")).not.toBeNull();
  });

  it("변경 기록을 못 읽어도 구간과 상태는 그리고 링크만 뺀다", async () => {
    getMemoryItemEvents.mockRejectedValue(new ApiError(500, "x"));
    const { host } = await render();
    await waitUntil(() => byTestId(host, "memory-timeline-links-error") !== null, "links error shown");
    expect(entries(host)).toHaveLength(4);
    expect(byTestId(host, "memory-timeline-links-error")?.textContent).toBe(TIMELINE_LINKS_ERROR);
    expect(byTestId(host, "memory-timeline-replaced")).toBeNull();
    expect(byTestId(host, "memory-timeline-interval")?.textContent).toContain("근거");
  });

  it("변경 기록을 읽는 상한을 넘으면 링크가 빠질 수 있다고 알린다", async () => {
    const many = Array.from({ length: 61 }, (_, i) =>
      item({
        id: `00000000-0000-7000-8000-0000000${String(8000 + i)}`,
        subjectKey: `주제 ${i}`,
        validFromMs: T0 + i * DAY,
        validToMs: T0 + (i + 1) * DAY,
      })
    );
    listMemoryItems.mockResolvedValue({ items: many });
    const { host } = await render();
    await waitUntil(() => getMemoryItemEvents.mock.calls.length >= 60, "60 event reads issued");
    await waitUntil(() => byTestId(host, "memory-timeline-links-capped") !== null, "cap notice shown");
    expect(byTestId(host, "memory-timeline-links-capped")).not.toBeNull();
    expect(getMemoryItemEvents).toHaveBeenCalledTimes(60);
  });

  it("상한 안에서는 알리지 않는다", async () => {
    const { host } = await render();
    await waitUntil(() => byTestId(host, "memory-timeline-replaced") !== null, "event links drawn");
    expect(byTestId(host, "memory-timeline-links-capped")).toBeNull();
  });

  it("밤사이 자동 정리와 되돌릴 수 있다는 안내를 준다", async () => {
    const { host } = await render();
    expect(byTestId(host, "memory-timeline-cleanup")?.textContent).toBe(CLEANUP_NOTE);
  });

  it("비어 있으면 안내하고, 실패하면 다시 시도를 준다", async () => {
    listMemoryItems.mockResolvedValue({ items: [] });
    const first = await render();
    expect(byTestId(first.host, "memory-timeline-empty")?.textContent).toContain(TIMELINE_EMPTY_HEADLINE);
    unmount();
    listMemoryItems.mockRejectedValue(new ApiError(500, "x"));
    const second = await render();
    expect(byTestId(second.host, "memory-timeline-error")?.textContent).toContain(TIMELINE_LOAD_ERROR);
  });

  it("보기 전환은 주소에 살고 채널 필터만 남긴다", async () => {
    const { host } = await render();
    expect(byTestId(host, "memory-browser-search")).toBeNull();
    expect(byTestId(host, "memory-browser-filter-kind")).toBeNull();
    expect(byTestId(host, "memory-browser-filter-channel")).not.toBeNull();
    click(byTestId(host, "memory-browser-view-list"));
    await waitUntil(() => byTestId(host, "memory-browser-search") !== null, "list view shown");
    expect(byTestId(host, "memory-timeline")).toBeNull();
    expect(byTestId(host, "memory-browser-search")).not.toBeNull();
  });

  it("폰 폭에서도 카드를 누르면 상세가 열린다", async () => {
    const { host } = await render({ mobile: true });
    click(byTestId(entries(host)[0] as HTMLElement, "memory-timeline-open"));
    await waitUntil(() => byTestId(host, "memory-detail") !== null, "detail opened on phone width");
    expect(byTestId(host, "memory-detail")).not.toBeNull();
  });
});

describe("정리 이력과 되돌리기", () => {
  const open = (id: string) => `/memory?view=timeline&item=${id}`;

  it("기간이 닫힌 결정의 이력에 이름표와 되돌리기가 붙고, 자동 정리라고 말한다", async () => {
    const { host } = await render({ route: open(OLD) });
    await waitUntil(historyReady(host, "memory-event-revert"), "history with revert shown");
    const event = byTestId(host, "memory-detail-event") as HTMLElement;
    expect(event.dataset.eventKind).toBe("closed");
    expect(event.textContent).toContain("새 결정이 나와서 유효 기간이 닫혔어요");
    expect(event.textContent).toContain("자동 정리");
    expect(byTestId(host, "memory-history-cleanup-note")?.textContent).toBe(HISTORY_CLEANUP_NOTE);
    expect(byTestId(event, "memory-event-revert")).not.toBeNull();
  });

  it("누르면 확인을 거치고, 확인해야 요청을 보낸다", async () => {
    const { host } = await render({ route: open(OLD) });
    await waitUntil(historyReady(host, "memory-event-revert"), "history with revert shown");
    click(byTestId(host, "memory-event-revert"));
    await waitUntil(dialogOpen, "revert dialog opened");
    expect(dialog()).not.toBeNull();
    expect(revertMemoryConsolidation).not.toHaveBeenCalled();
    expect(dialogButton("memory-revert-description")?.textContent).toContain("닫힌 결정을 다시");
    click(dialogButton("memory-revert-cancel"));
    await waitUntil(() => !dialogOpen(), "revert dialog closed after cancel");
    expect(revertMemoryConsolidation).not.toHaveBeenCalled();
    click(byTestId(host, "memory-event-revert"));
    await waitUntil(dialogOpen, "revert dialog reopened");
    click(dialogButton("memory-revert-confirm"));
    await waitUntil(
      () => byTestId(host, "memory-browser-notice")?.textContent?.includes("닫힌 기간을 되돌렸어요") === true,
      "revert notice shown"
    );
    expect(revertMemoryConsolidation).toHaveBeenCalledWith(WS, OLD, CLOSE_EVENT);
    expect(byTestId(host, "memory-browser-notice")?.textContent).toContain("닫힌 기간을 되돌렸어요");
  });

  it("되돌린 뒤에는 목록과 이력을 다시 읽는다", async () => {
    const { host } = await render({ route: open(OLD) });
    await waitUntil(historyReady(host, "memory-event-revert"), "history with revert shown");
    const before = listMemoryItems.mock.calls.length;
    click(byTestId(host, "memory-event-revert"));
    await waitUntil(dialogOpen, "revert dialog opened");
    click(dialogButton("memory-revert-confirm"));
    await waitUntil(() => listMemoryItems.mock.calls.length > before, "list re-read after revert");
    expect(listMemoryItems.mock.calls.length).toBeGreaterThan(before);
  });

  it("합침과 감쇠는 그 종류에 맞는 결과를 설명한다", async () => {
    const merged = await render({ route: open(MERGED) });
    await waitUntil(historyReady(merged.host, "memory-event-revert"), "merged history shown");
    click(byTestId(merged.host, "memory-event-revert"));
    await waitUntil(dialogOpen, "revert dialog opened (merged)");
    expect(dialogButton("memory-revert-description")?.textContent).toContain("다시 합치지 않아요");
    unmount();
    document.body.innerHTML = "";
    const decayed = await render({ route: open(DECAYED) });
    await waitUntil(historyReady(decayed.host, "memory-event-revert"), "decayed history shown");
    click(byTestId(decayed.host, "memory-event-revert"));
    await waitUntil(dialogOpen, "revert dialog opened (decayed)");
    expect(dialogButton("memory-revert-description")?.textContent).toContain("14일");
  });

  it("이미 되돌린 사건은 되돌렸다고만 말하고 버튼을 접는다", async () => {
    EVENTS[OLD] = [
      CLOSE,
      { id: "e-rev", action: "reverted", actorMemberId: ME, detail: { of: CLOSE_EVENT, what: "superseded" }, createdAtMs: T0 + 7 * DAY },
    ];
    try {
      const { host } = await render({ route: open(OLD) });
      await waitUntil(historyReady(host, "memory-event-reverted"), "reverted marker shown");
      const rows = host.querySelectorAll('[data-testid="memory-detail-event"]');
      expect(rows).toHaveLength(2);
      expect(byTestId(host, "memory-event-reverted")?.textContent).toBe("되돌렸어요");
      expect(byTestId(host, "memory-event-revert")).toBeNull();
      expect(rows[1]?.textContent).toContain("유효 기간 닫기를 되돌렸어요");
    } finally {
      EVENTS[OLD] = [CLOSE];
    }
  });

  it("되돌릴 수 없는 사건(고쳐 쓰기·근거 소실)에는 버튼이 없다", async () => {
    EVENTS[OLD] = [
      { id: "e1", action: "superseded", detail: { reason: "edited", superseded_by: NEW }, createdAtMs: T0 },
      { id: "e2", action: "retired", detail: { reason: "source_deleted" }, createdAtMs: T0 },
      { id: "e3", action: "merged", detail: { absorbed: MERGED }, createdAtMs: T0 },
    ];
    try {
      const { host } = await render({ route: open(OLD) });
      await waitUntil(
        () => host.querySelectorAll('[data-testid="memory-detail-event"]').length === 3,
        "three events shown"
      );
      expect(host.querySelectorAll('[data-testid="memory-detail-event"]')).toHaveLength(3);
      expect(byTestId(host, "memory-event-revert")).toBeNull();
    } finally {
      EVENTS[OLD] = [CLOSE];
    }
  });

  it("게스트는 이력을 읽기만 하고 이유를 듣는다", async () => {
    const { host } = await render({ role: "guest", route: open(OLD) });
    await waitUntil(historyReady(host), "history shown");
    expect(byTestId(host, "memory-detail-event")?.textContent).toContain("유효 기간이 닫혔어요");
    expect(byTestId(host, "memory-event-revert")).toBeNull();
    expect(byTestId(host, "memory-history-guest")?.textContent).toBe(REVERT_GUEST_READONLY);
  });

  it.each([
    [403, REVERT_FORBIDDEN_MESSAGE],
    [409, REVERT_CONFLICT_MESSAGE],
    [422, REVERT_UNSUPPORTED_MESSAGE],
    [500, REVERT_FAILED_MESSAGE],
  ])("실패 %i는 정해진 한 문장으로 돌려준다", async (status, message) => {
    revertMemoryConsolidation.mockRejectedValue(new ApiError(status, "x"));
    const { host } = await render({ route: open(OLD) });
    await waitUntil(historyReady(host, "memory-event-revert"), "history with revert shown");
    click(byTestId(host, "memory-event-revert"));
    await waitUntil(dialogOpen, "revert dialog opened");
    click(dialogButton("memory-revert-confirm"));
    await waitUntil(
      () => byTestId(host, "memory-history-error") !== null && !dialogOpen(),
      "revert error shown and dialog closed"
    );
    expect(byTestId(host, "memory-history-error")?.textContent).toContain(message);
    expect(dialog()?.getAttribute("data-state")).not.toBe("open");
  });

  it("404는 없거나 볼 수 없다고만 말하고 상세를 닫는다", async () => {
    revertMemoryConsolidation.mockRejectedValue(new ApiError(404, "x"));
    const { host } = await render({ route: open(OLD) });
    await waitUntil(historyReady(host, "memory-event-revert"), "history with revert shown");
    click(byTestId(host, "memory-event-revert"));
    await waitUntil(dialogOpen, "revert dialog opened");
    click(dialogButton("memory-revert-confirm"));
    await waitUntil(
      () =>
        byTestId(host, "memory-browser-notice")?.textContent?.includes(REVERT_GONE_MESSAGE) === true &&
        byTestId(host, "memory-detail") === null,
      "gone notice shown and detail closed"
    );
    expect(byTestId(host, "memory-browser-notice")?.textContent).toContain(REVERT_GONE_MESSAGE);
    expect(byTestId(host, "memory-detail")).toBeNull();
  });

  it("연결이 끊기면 되돌리기를 잠그고 이유를 말한다", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { host } = await render({ route: open(OLD) });
    await waitUntil(historyReady(host, "memory-history-offline"), "offline note shown");
    expect(byTestId(host, "memory-history-offline")?.textContent).toContain("연결이 끊겨");
    expect(byTestId(host, "memory-event-revert")?.hasAttribute("disabled")).toBe(true);
    vi.restoreAllMocks();
  });
});
