// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  BROWSER_EMPTY_HEADLINE,
  BROWSER_GUEST_READONLY,
  BROWSER_LOAD_ERROR,
  BROWSER_NOT_CURRENT,
  BROWSER_OPEN_ITEM_GONE,
  BROWSER_PAUSED_NOTICE,
  EDIT_NOTICE,
  FORGET_DESCRIPTION,
  ITEM_CONFLICT_MESSAGE,
  ITEM_EDIT_REFUSED_MESSAGE,
  ITEM_FORBIDDEN_MESSAGE,
} from "@momo/core/features/memory/browser";
import { MemoryBrowserRoute } from "./MemoryBrowserRoute";
import {
  AGENT,
  CH,
  ITEM,
  JIHOON,
  MSG_A,
  ME,
  WS,
  byTestId,
  click,
  flush,
  waitUntil,
  item,
  mount,
  settings,
  type as typeInto,
  unmount,
} from "./memoryTestKit";

const listMemoryItems = vi.hoisted(() => vi.fn());
const getMemoryItem = vi.hoisted(() => vi.fn());
const getMemoryItemEvents = vi.hoisted(() => vi.fn());
const editMemoryItem = vi.hoisted(() => vi.fn());
const forgetMemoryItem = vi.hoisted(() => vi.fn());
const getMemorySettings = vi.hoisted(() => vi.fn());
const listChannels = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    listMemoryItems: (...a: unknown[]) => listMemoryItems(...a) as unknown,
    getMemoryItem: (...a: unknown[]) => getMemoryItem(...a) as unknown,
    getMemoryItemEvents: (...a: unknown[]) => getMemoryItemEvents(...a) as unknown,
    editMemoryItem: (...a: unknown[]) => editMemoryItem(...a) as unknown,
    forgetMemoryItem: (...a: unknown[]) => forgetMemoryItem(...a) as unknown,
    getMemorySettings: (...a: unknown[]) => getMemorySettings(...a) as unknown,
  };
});
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, listChannels: (...a: unknown[]) => listChannels(...a) as unknown };
});

const EVIDENCE = [{ messageId: MSG_A, channelId: CH, seq: 41 }];
const OLDER = "00000000-0000-7000-8000-000000000702";
const NEWER = "00000000-0000-7000-8000-000000000703";

beforeEach(() => {
  listMemoryItems.mockReset().mockResolvedValue({ items: [item()] });
  getMemoryItem.mockReset().mockResolvedValue({ item: item(), evidence: EVIDENCE });
  getMemoryItemEvents.mockReset().mockResolvedValue([
    { id: "e1", action: "created", detail: {}, createdAtMs: 1_800_000_000_000 },
    { id: "e2", action: "mystery_action", actorMemberId: JIHOON, detail: {}, createdAtMs: 1_800_000_100_000 },
  ]);
  editMemoryItem.mockReset().mockResolvedValue({
    item: item({ id: NEWER, origin: "curated", body: "큐 크기를 두 배로 늘려요.", editedByMemberId: ME, editedAtMs: 1_800_000_200_000 }),
    evidence: EVIDENCE,
    supersededId: ITEM,
  });
  forgetMemoryItem.mockReset().mockResolvedValue(1);
  getMemorySettings.mockReset().mockResolvedValue(settings());
  listChannels.mockReset().mockResolvedValue([
    { id: CH, workspaceId: WS, kind: "public", name: "결제-개발", muted: false },
  ]);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

async function render(
  options: { role?: "member" | "guest" | "admin"; route?: string; mobile?: boolean } = {}
) {
  const view = mount(createElement(MemoryBrowserRoute), {
    role: options.role ?? "member",
    route: options.route ?? "/memory",
    mobile: options.mobile === true,
  });
  for (let i = 0; i < 6; i += 1) await flush();
  return view;
}

const has = (host: HTMLElement, id: string) => () => byTestId(host, id) !== null;
const rowsCount = (host: HTMLElement, n: number) => () =>
  host.querySelectorAll('[data-testid="memory-browser-row"]').length === n;
const rows = (host: HTMLElement) =>
  host.querySelectorAll('[data-testid="memory-browser-row"]');

describe("기억 브라우저: 목록", () => {
  it("항목을 종류·채널·날짜와 함께 나열하고 아무것도 고르지 않았으면 안내한다", async () => {
    const { host } = await render();
    expect(rows(host)).toHaveLength(1);
    expect(rows(host)[0]?.textContent).toContain("결정");
    expect(rows(host)[0]?.textContent).toContain("# 결제-개발");
    expect(byTestId(host, "memory-browser-pick")).not.toBeNull();
    expect(listMemoryItems).toHaveBeenCalledWith(WS, expect.objectContaining({ status: "active" }));
  });

  it("고른 필터와 검색어를 서버 질의로 옮기고, 검색 중에는 상태 필터를 잠근다", async () => {
    const { host } = await render({ route: "/memory?kind=fact&channel=" + CH });
    expect(listMemoryItems).toHaveBeenLastCalledWith(
      WS,
      expect.objectContaining({ kind: "fact", channelId: CH, status: "active" })
    );
    typeInto(byTestId<HTMLInputElement>(host, "memory-browser-search"), "재시도 큐");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitUntil(
      () =>
        listMemoryItems.mock.lastCall?.[1] !== undefined &&
        (listMemoryItems.mock.lastCall[1] as { q?: string }).q === "재시도 큐",
      "search query sent to the server"
    );
    expect(listMemoryItems).toHaveBeenLastCalledWith(
      WS,
      expect.objectContaining({ q: "재시도 큐" })
    );
    await waitUntil(() => byTestId<HTMLSelectElement>(host, "memory-browser-filter-status")?.disabled === true, "status filter locked");
    expect(byTestId<HTMLSelectElement>(host, "memory-browser-filter-status")?.disabled).toBe(true);
    expect(byTestId(host, "memory-browser-search-note")).not.toBeNull();
  });

  it("다음 쪽이 있으면 더 보기를 주고 커서로 이어 읽는다", async () => {
    listMemoryItems
      .mockResolvedValueOnce({ items: [item()], nextCursor: "c1" })
      .mockResolvedValueOnce({ items: [item({ id: OLDER, body: "배포는 목요일 오전이에요." })] });
    const { host } = await render();
    click(byTestId(host, "memory-browser-more"));
    await waitUntil(rowsCount(host, 2), "second page rendered");
    expect(listMemoryItems).toHaveBeenLastCalledWith(WS, expect.objectContaining({ cursor: "c1" }));
    expect(rows(host)).toHaveLength(2);
    expect(byTestId(host, "memory-browser-more")).toBeNull();
  });

  it("비어 있으면 안내하고, 필터 때문에 비면 필터를 지우게 한다", async () => {
    listMemoryItems.mockResolvedValue({ items: [] });
    const first = await render();
    await waitUntil(has(first.host, "memory-browser-empty"), "empty state");
    expect(byTestId(first.host, "memory-browser-empty")?.textContent).toContain(BROWSER_EMPTY_HEADLINE);
    unmount();
    const second = await render({ route: "/memory?kind=fact" });
    await waitUntil(has(second.host, "memory-browser-no-match"), "no-match state");
    expect(byTestId(second.host, "memory-browser-no-match")).not.toBeNull();
    expect(byTestId(second.host, "memory-browser-empty")).toBeNull();
  });

  it("읽기에 실패하면 이유와 다시 시도를 준다. 서버에 경로가 없으면(404) 시도 버튼이 없다", async () => {
    listMemoryItems.mockRejectedValue(new ApiError(500, "x"));
    const first = await render();
    await waitUntil(has(first.host, "memory-browser-error"), "load error");
    expect(byTestId(first.host, "memory-browser-error")?.textContent).toContain(BROWSER_LOAD_ERROR);
    expect(first.host.textContent).toContain("다시 시도");
    unmount();
    listMemoryItems.mockRejectedValue(new ApiError(404, "x"));
    const second = await render();
    await waitUntil(
      () => second.host.textContent?.includes("이 서버는 아직 팀 기억을 지원하지 않아요.") === true,
      "unsupported-server message"
    );
    expect(second.host.textContent).toContain("이 서버는 아직 팀 기억을 지원하지 않아요.");
    expect(second.host.textContent).not.toContain("다시 시도");
  });

  it("비어 있을 때는 고르라는 안내를 내지 않는다", async () => {
    listMemoryItems.mockResolvedValue({ items: [] });
    const { host } = await render();
    await waitUntil(has(host, "memory-browser-empty"), "empty state");
    expect(byTestId(host, "memory-browser-pick")).toBeNull();
  });

  it("폰에서 항목을 고르면 캐럿이 상세로 간다", async () => {
    const { host } = await render({ mobile: true });
    await waitUntil(rowsCount(host, 1), "list rows rendered");
    click(rows(host)[0] ?? null);
    await waitUntil(has(host, "memory-detail"), "detail opened");
    await waitUntil(
      () => document.activeElement === byTestId(host, "memory-detail-body"),
      "focus moved to detail body"
    );
    expect(byTestId(host, "memory-detail")).not.toBeNull();
    expect(document.activeElement).toBe(byTestId(host, "memory-detail-body"));
  });

  it("내 일시정지가 켜져 있으면 알리고 설정으로 보낸다", async () => {
    getMemorySettings.mockResolvedValue(settings({ me: { paused: true } }));
    const { host } = await render();
    await waitUntil(has(host, "memory-browser-paused"), "paused notice");
    expect(byTestId(host, "memory-browser-paused")?.textContent).toContain(BROWSER_PAUSED_NOTICE);
    expect(
      byTestId(host, "memory-browser-paused")?.querySelector("a")?.getAttribute("href")
    ).toBe("/settings?section=memory");
  });
});

describe("기억 브라우저: 상세", () => {
  it("근거 역링크·출처·이력(모르는 사건은 일반 문장)을 보인다", async () => {
    const { host } = await render({ route: `/memory?item=${ITEM}` });
    await waitUntil(
      () => host.querySelectorAll('[data-testid="memory-detail-event"]').length === 2 && has(host, "memory-detail-evidence-link")(),
      "detail, evidence and history loaded"
    );
    expect(byTestId(host, "memory-detail-body")?.textContent).toContain("두 배로");
    expect(byTestId(host, "memory-detail-origin")?.textContent).toBe("사람이 확인했어요");
    const link = byTestId(host, "memory-detail-evidence-link");
    expect(link?.getAttribute("href")).toContain(MSG_A);
    const events = host.querySelectorAll('[data-testid="memory-detail-event"]');
    expect(events).toHaveLength(2);
    expect(events[0]?.textContent).toContain("만들어졌어요");
    expect(events[1]?.textContent).toContain("기록이 남았어요");
    expect(events[1]?.textContent).toContain("박지훈");
    expect(events[1]?.textContent).not.toContain("mystery_action");
  });

  it("고친 항목은 누가 언제 고쳤는지 보인다", async () => {
    getMemoryItem.mockResolvedValue({
      item: item({ origin: "curated", editedByMemberId: JIHOON, editedAtMs: 1_800_000_200_000, supersedesId: OLDER }),
      evidence: EVIDENCE,
    });
    const { host } = await render({ route: `/memory?item=${ITEM}` });
    await waitUntil(has(host, "memory-detail-open-older"), "edited detail loaded");
    expect(byTestId(host, "memory-detail-edited-by")?.textContent).toContain("고친 사람 박지훈");
    expect(byTestId(host, "memory-detail-open-older")).not.toBeNull();
  });

  it("없는 기억(404)은 없거나 볼 수 없다고만 말한다", async () => {
    getMemoryItem.mockRejectedValue(new ApiError(404, "x"));
    const { host } = await render({ route: `/memory?item=${ITEM}` });
    await waitUntil(has(host, "memory-detail-gone"), "gone notice");
    expect(byTestId(host, "memory-detail-gone")?.textContent).toContain(BROWSER_OPEN_ITEM_GONE);
    expect(byTestId(host, "memory-detail-gone")?.textContent).not.toMatch(/권한/);
  });

  it("폰 폭에서는 상세만 보이고 목록으로 돌아갈 수 있다", async () => {
    const { host } = await render({ route: `/memory?item=${ITEM}`, mobile: true });
    await waitUntil(has(host, "memory-detail"), "detail loaded");
    expect(byTestId(host, "memory-browser-list-pane")).toBeNull();
    click(byTestId(host, "memory-browser-back"));
    await waitUntil(has(host, "memory-browser-list-pane"), "list pane back");
    expect(byTestId(host, "memory-browser-list-pane")).not.toBeNull();
    expect(byTestId(host, "memory-detail")).toBeNull();
  });
});

describe("기억 브라우저: 오프라인", () => {
  it("연결이 끊기면 알리고, 상세의 고치기·잊기는 이유와 함께 잠근다", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { host } = await render({ route: `/memory?item=${ITEM}` });
    await waitUntil(
      () => has(host, "memory-browser-offline")() && has(host, "memory-detail-reason")() && rowsCount(host, 1)(),
      "offline view loaded"
    );
    expect(byTestId(host, "memory-browser-offline")?.textContent).toContain("연결이 끊겨 있어요");
    // 캐시된 목록은 계속 보인다.
    expect(rows(host)).toHaveLength(1);
    expect(byTestId(host, "memory-detail-edit")).toBeNull();
    expect(byTestId(host, "memory-detail-reason")?.textContent).toContain("연결이 끊겨 있어서");
    vi.restoreAllMocks();
  });
});

describe("기억 브라우저: 게스트·지난 버전", () => {
  it("게스트은 읽기만 한다. 고치기·잊기 버튼이 없고 이유를 듣는다", async () => {
    const { host } = await render({ role: "guest", route: `/memory?item=${ITEM}` });
    await waitUntil(has(host, "memory-detail-reason"), "guest detail loaded");
    expect(byTestId(host, "memory-detail")).not.toBeNull();
    expect(byTestId(host, "memory-detail-edit")).toBeNull();
    expect(byTestId(host, "memory-detail-forget")).toBeNull();
    expect(byTestId(host, "memory-detail-reason")?.textContent).toBe(BROWSER_GUEST_READONLY);
  });

  it("지난 버전은 고치거나 잊을 수 없고, 최신 버전으로 가는 길을 준다", async () => {
    getMemoryItem.mockResolvedValue({
      item: item({ retiredAtMs: 1_800_000_300_000, retiredReason: "edited", supersededById: NEWER }),
      evidence: EVIDENCE,
    });
    const { host } = await render({ route: `/memory?item=${ITEM}` });
    await waitUntil(has(host, "memory-detail-open-newer"), "old version loaded");
    expect(byTestId(host, "memory-detail-edit")).toBeNull();
    expect(byTestId(host, "memory-detail-forget")).toBeNull();
    expect(byTestId(host, "memory-detail-reason")?.textContent).toBe(BROWSER_NOT_CURRENT);
    expect(byTestId(host, "memory-detail-open-newer")).not.toBeNull();
  });
});

describe("기억 브라우저: 고치기", () => {
  async function openEditor() {
    const view = await render({ route: `/memory?item=${ITEM}` });
    await waitUntil(has(view.host, "memory-detail-edit"), "detail loaded");
    click(byTestId(view.host, "memory-detail-edit"));
    await waitUntil(has(view.host, "memory-edit-form"), "editor opened");
    return view;
  }

  it("고치기 전에 이력이 남는다는 안내와 잊기 안내를 보인다", async () => {
    const { host } = await openEditor();
    expect(byTestId(host, "memory-edit-notice")?.textContent).toBe(EDIT_NOTICE);
    expect(EDIT_NOTICE).toContain("이력에 남아요");
    expect(EDIT_NOTICE).toContain("「잊기」");
  });

  it("바뀐 게 없거나 비어 있으면 서버에 보내지 않고 이유를 말한다", async () => {
    const { host } = await openEditor();
    click(byTestId(host, "memory-edit-save"));
    await waitUntil(has(host, "memory-edit-problem"), "unchanged problem shown");
    expect(byTestId(host, "memory-edit-problem")?.textContent).toBe("바뀐 내용이 없어요.");
    typeInto(byTestId<HTMLTextAreaElement>(host, "memory-edit-field"), "   ");
    click(byTestId(host, "memory-edit-save"));
    await waitUntil(
      () => byTestId(host, "memory-edit-problem")?.textContent === "내용을 적어 주세요.",
      "empty problem shown"
    );
    expect(byTestId(host, "memory-edit-problem")?.textContent).toBe("내용을 적어 주세요.");
    expect(editMemoryItem).not.toHaveBeenCalled();
  });

  it("저장하면 새 버전으로 옮겨 가고 이력이 남았다고 알린다", async () => {
    const { host } = await openEditor();
    typeInto(byTestId<HTMLTextAreaElement>(host, "memory-edit-field"), "큐 크기를 두 배로 늘려요.");
    click(byTestId(host, "memory-edit-save"));
    await waitUntil(
      () => byTestId(host, "memory-browser-notice")?.textContent?.includes("이력에 남았") === true && byTestId(host, "memory-edit-form") === null,
      "save notice shown and editor closed"
    );
    expect(editMemoryItem).toHaveBeenCalledWith(WS, ITEM, { body: "큐 크기를 두 배로 늘려요." });
    expect(byTestId(host, "memory-browser-notice")?.textContent).toContain("이력에 남았");
    expect(byTestId(host, "memory-edit-form")).toBeNull();
  });

  it("422는 바뀐 게 없는 경우와 숨은 항목이 있는 경우를 가르지 않고 한 문장으로 말한다", async () => {
    editMemoryItem.mockRejectedValue(new ApiError(422, "unchanged"));
    const { host } = await openEditor();
    typeInto(byTestId<HTMLTextAreaElement>(host, "memory-edit-field"), "다른 문장이에요.");
    click(byTestId(host, "memory-edit-save"));
    await waitUntil(has(host, "memory-detail-write-error"), "write error shown");
    expect(byTestId(host, "memory-detail-write-error")?.textContent).toContain(
      ITEM_EDIT_REFUSED_MESSAGE
    );
  });

  it("403(채널 게스트)은 게스트 문장, 409는 다시 읽었다는 문장이다", async () => {
    editMemoryItem.mockRejectedValueOnce(new ApiError(403, "guest"));
    const { host } = await openEditor();
    typeInto(byTestId<HTMLTextAreaElement>(host, "memory-edit-field"), "다른 문장이에요.");
    click(byTestId(host, "memory-edit-save"));
    await waitUntil(
      () => byTestId(host, "memory-detail-write-error")?.textContent?.includes(ITEM_FORBIDDEN_MESSAGE) === true,
      "forbidden message shown"
    );
    expect(byTestId(host, "memory-detail-write-error")?.textContent).toContain(ITEM_FORBIDDEN_MESSAGE);
    editMemoryItem.mockRejectedValueOnce(new ApiError(409, "stale"));
    click(byTestId(host, "memory-edit-save"));
    await waitUntil(
      () => byTestId(host, "memory-detail-write-error")?.textContent?.includes(ITEM_CONFLICT_MESSAGE) === true,
      "conflict message shown"
    );
    expect(byTestId(host, "memory-detail-write-error")?.textContent).toContain(ITEM_CONFLICT_MESSAGE);
  });
});

describe("기억 브라우저: 잊기", () => {
  async function openForget() {
    const view = await render({ route: `/memory?item=${ITEM}` });
    await waitUntil(has(view.host, "memory-detail-forget"), "detail loaded");
    click(byTestId(view.host, "memory-detail-forget"));
    await waitUntil(() => dialog() !== null, "forget dialog opened");
    return view;
  }
  const dialog = () => document.body.querySelector('[data-testid="memory-forget-dialog"]');

  it("누르기만 해서는 지우지 않는다. 확인 창이 되돌릴 수 없다고 말하되 다시는 안 나온다고 약속하지 않는다", async () => {
    await openForget();
    expect(forgetMemoryItem).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).toContain(FORGET_DESCRIPTION);
    expect(dialog()?.textContent).toContain("되돌릴 수 없어요");
    expect(dialog()?.textContent).not.toMatch(/다시는|절대|영원히/);
  });

  it("취소하면 아무것도 지우지 않는다", async () => {
    await openForget();
    click(document.body.querySelector('[data-testid="memory-forget-cancel"]'));
    await waitUntil(() => dialog() === null, "forget dialog closed");
    expect(forgetMemoryItem).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("확인하면 지우고 목록으로 돌아가 알린다", async () => {
    const { host } = await openForget();
    click(document.body.querySelector('[data-testid="memory-forget-confirm"]'));
    await waitUntil(
      () => byTestId(host, "memory-browser-notice")?.textContent?.includes("잊었어요") === true && byTestId(host, "memory-detail") === null,
      "forgotten notice shown and detail closed"
    );
    expect(forgetMemoryItem).toHaveBeenCalledWith(WS, ITEM);
    expect(byTestId(host, "memory-detail")).toBeNull();
    expect(byTestId(host, "memory-browser-notice")?.textContent).toContain("잊었어요");
  });

  it("지우기에 실패하면 창을 닫고 이유를 남긴다 (403은 게스트 문장)", async () => {
    forgetMemoryItem.mockRejectedValue(new ApiError(403, "guest"));
    const { host } = await openForget();
    click(document.body.querySelector('[data-testid="memory-forget-confirm"]'));
    await waitUntil(
      () => dialog() === null && has(host, "memory-detail-write-error")(),
      "dialog closed and error shown"
    );
    expect(dialog()).toBeNull();
    expect(byTestId(host, "memory-detail-write-error")?.textContent).toContain(ITEM_FORBIDDEN_MESSAGE);
    expect(byTestId(host, "memory-detail")).not.toBeNull();
  });

  it("에이전트나 목록에 없는 id로 열어도 화면이 죽지 않는다", async () => {
    getMemoryItem.mockRejectedValue(new ApiError(404, "x"));
    const { host } = await render({ route: `/memory?item=${AGENT}` });
    await waitUntil(has(host, "memory-detail-gone"), "gone notice");
    expect(byTestId(host, "memory-detail-gone")).not.toBeNull();
  });
});
