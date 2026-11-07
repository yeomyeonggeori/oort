// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, waitFor, within } from "@testing-library/react";
import { FIXTURE_EXPRESSIONS, FIXTURE_LIST, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import { EXPRESSION_GRID_COLS } from "@momo/core/features/expressions/gridSections";
import { emptyExpressionFavorites, toggleExpressionFavorite } from "@momo/core/features/expressions/favorites";
import { emptyExpressionUsage, recordExpressionUse } from "@momo/core/features/expressions/usage";
import type { Expression, ExpressionList } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import type { ExpressionTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { TeamExpressionsPanel } from "./TeamExpressionsPanel";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]), authedResponse: vi.fn() }));

// 이모티콘·GIF 탭의 그림 격자 (owner 2026-11-07, #5453): 구역(최근 -> 즐겨찾기 -> 세트별 -> 기타) · 세트 띠 · 칸 메뉴의 즐겨찾기 · 방향키.
// 이 시험은 제공자 없는 고정 영어 사전으로 돈다: 구역·띠의 이름은 「Frequent & recent」(이모티콘 보기 맨 위 칸, #5503)·「Favorites」·「Other」·「Add」이고 세트 이름표는 등록된 표현의 데이터다.

const WS = FIXTURE_WORKSPACE_ID;
const ME = FIXTURE_MEMBER_ID;
const usageKey = `oort.expressions.usage:${WS}:${ME}`;
const favoritesKey = `oort.expressions.favorites:${WS}:${ME}`;
const png = FIXTURE_MEDIA.png.image;
const STILL = { small: { ...png }, large: { ...png }, thumb: { ...png } };
let serial = 200;
const made = (name: string, tags: string[] = [], extra: Partial<Expression> = {}): Expression => ({
  ...FIXTURE_EXPRESSIONS[1], id: `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`, name, displayName: name, tags, kind: "sticker", media: STILL, status: "active", ...extra,
});
// 세트 둘(공통 태그가 있는 dam, 없는 chi)과 낱개 하나. 코어 기본 차례는 이름순이라 구역은 chi -> dam -> 기타다.
const dam = ["dam_a", "dam_b", "dam_c"].map((name) => made(name, ["농담곰"]));
const chi = ["chi_a", "chi_b"].map((name) => made(name));
const solo = made("solo");
const ITEMS = [...dam, ...chi, solo];
const idOf = (name: string) => ITEMS.find((item) => item.name === name)!.id;

function storeOf(items: Expression[], seed: { used?: string[]; starred?: string[] } = {}) {
  if (seed.used) {
    let usage = emptyExpressionUsage(WS, ME);
    seed.used.forEach((name, i) => { usage = recordExpressionUse(usage, idOf(name), 1000 + i); });
    localStorage.setItem(usageKey, JSON.stringify(usage));
  }
  if (seed.starred) localStorage.setItem(favoritesKey, JSON.stringify(seed.starred.reduce((fav, name) => toggleExpressionFavorite(fav, idOf(name)), emptyExpressionFavorites(WS, ME))));
  const list: ExpressionList = { ...FIXTURE_LIST, version: "9", items };
  const transport: ExpressionTransport = { json: async () => list, image: async () => "data:image/png;base64,AA==" };
  return new ExpressionStore(WS, ME, transport);
}
async function mount(store: ExpressionStore, onPick = vi.fn(), onPickExpression?: (item: Expression) => void) {
  await store.refresh();
  const view = render(<ExpressionsContext.Provider value={store}><TeamExpressionsPanel purpose="insert" view="emoticon" onPick={onPick} {...(onPickExpression ? { onPickExpression } : {})} /></ExpressionsContext.Provider>);
  await act(async () => {});
  return { view, onPick };
}
const sectionsOf = (view: ReturnType<typeof render>) => [...view.container.querySelectorAll<HTMLElement>("[data-section]")];
const cellsIn = (section: HTMLElement) => [...section.querySelectorAll<HTMLButtonElement>("button")].map((button) => (button.getAttribute("aria-label") ?? "").replace(" 메시지에 넣기", ""));
const shape = (view: ReturnType<typeof render>) => sectionsOf(view).map((section) => [section.getAttribute("data-section"), section.querySelector("p")?.textContent ?? null, cellsIn(section)]);
const stripOf = (view: ReturnType<typeof render>) => view.getByTestId("expression-set-strip");
const stripLabels = (view: ReturnType<typeof render>) => [...stripOf(view).querySelectorAll<HTMLElement>("[data-strip]")].map((button) => button.getAttribute("aria-label"));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("그림 격자: 구역과 칸", () => {
  it("구역은 최근 -> 즐겨찾기 -> 세트별 -> 기타이고, 세트 이름표는 공통 태그(없으면 앞머리)다", async () => {
    const { view } = await mount(storeOf(ITEMS, { used: ["solo", "dam_b"], starred: ["chi_b", "dam_c"] }));
    expect(shape(view)).toEqual([
      ["recent", "Frequent & recent", ["dam_b", "solo"]],
      ["favorites", "Favorites", ["chi_b", "dam_c"]],
      ["set:chi", "chi", ["chi_a", "chi_b"]],
      ["set:dam", "농담곰", ["dam_a", "dam_b", "dam_c"]],
      ["other", "Other", ["solo"]],
    ]);
  });

  it("쓴 적도 별표도 없고 세트도 없으면 구역 이름줄이 없다 - 구역 하나를 「기타」로 부르지 않는다", async () => {
    const { view } = await mount(storeOf([made("alpha"), made("beta")]));
    expect(shape(view)).toEqual([["other", null, ["alpha", "beta"]]]);
  });

  it("칸에는 그림뿐이다: 이름·`:코드:`·안내 글이 없고, 이름은 낭독 이름과 title 에만 있다. 한 줄 6칸이다", async () => {
    const { view } = await mount(storeOf(ITEMS));
    await waitFor(() => expect(view.container.querySelectorAll("[data-testid='expression-grid'] img")).toHaveLength(ITEMS.length));
    const grid = view.getByTestId("expression-grid");
    for (const cell of grid.querySelectorAll("button")) expect(cell.textContent).toBe("");
    expect(grid.textContent).not.toMatch(/:[a-z_]+:/);
    // 옛 안내 글(owner: 텍스트는 같이 노출 안 하고 카카오톡처럼)은 창 어디에도 없다.
    expect(view.container.textContent).not.toContain("한 보관함의 그림을 반응이나 메시지에 쓸 수 있어요");
    const first = grid.querySelector("button")!;
    expect(first.getAttribute("title")).toBe("chi_a");
    expect(first.getAttribute("aria-label")).toBe("chi_a 메시지에 넣기");
    // 열 수는 방향키 모델(코어 EXPRESSION_GRID_COLS)과 같은 숫자여야 한다 - 다르면 위아래 키가 화면의 줄과 어긋난다.
    for (const list of grid.querySelectorAll("[data-section] > div")) expect(list.className).toContain(`grid-cols-${EXPRESSION_GRID_COLS}`);
  });

  it("칸을 누르면 그 등록을 고른다: 메인 컴포저는 표현 자체를(onPickExpression), 그 밖은 `:이름:` 글을 넘긴다", async () => {
    const { view, onPick } = await mount(storeOf(ITEMS));
    fireEvent.click(view.getByRole("button", { name: "dam_b 메시지에 넣기" }));
    expect(onPick).toHaveBeenCalledWith(":dam_b:");
    cleanup();
    const pickExpression = vi.fn();
    const again = await mount(storeOf(ITEMS), vi.fn(), pickExpression);
    fireEvent.click(again.view.getByRole("button", { name: "solo 메시지에 넣기" }));
    expect(pickExpression).toHaveBeenCalledTimes(1);
    expect(pickExpression.mock.calls[0]![0].name).toBe("solo");
    expect(again.onPick).not.toHaveBeenCalled();
  });

  it("검색어가 있으면 구역 없이 결과 하나이고(관련도 차례), 세트 단추는 서지 않지만 ＋는 남는다", async () => {
    const { view } = await mount(storeOf(ITEMS, { used: ["solo"], starred: ["dam_a"] }));
    fireEvent.change(view.getByLabelText("Search emoticons"), { target: { value: "dam_b" } });
    expect(shape(view)).toEqual([["results", null, ["dam_b"]]]);
    expect(stripLabels(view)).toEqual([]);
    expect(view.getByTestId("expression-add-menu")).toBeTruthy();
    fireEvent.change(view.getByLabelText("Search emoticons"), { target: { value: "zzzz" } });
    expect(sectionsOf(view)).toHaveLength(0);
    expect(view.container.textContent).toContain("맞는 팀 그림이 없어요");
    expect(view.getByTestId("expression-add-menu")).toBeTruthy();
  });

  it("보관함이 비어도 ＋는 서서 올리는 길이 막히지 않는다", async () => {
    const { view } = await mount(storeOf([]));
    expect(view.container.textContent).toContain("아직 팀 그림이 없어요");
    expect(sectionsOf(view)).toHaveLength(0);
    expect((view.getByTestId("expression-add-menu") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("네 상태에서도 ＋는 닿는다(예전 머리 줄의 「추가하기」처럼)", () => {
  const failing = (store: ExpressionStore) => { store.transport.json = vi.fn().mockRejectedValue(new Error("down")); return store; };
  it("불러오는 중: 스켈레톤이 서고 ＋도 서 있다", async () => {
    const store = storeOf(ITEMS); // refresh 전 = loading
    const view = render(<ExpressionsContext.Provider value={store}><TeamExpressionsPanel purpose="insert" view="emoticon" onPick={() => {}} /></ExpressionsContext.Provider>);
    await act(async () => {});
    expect(store.getSnapshot().status).toBe("loading");
    expect(view.queryByTestId("expression-grid")).toBeNull();
    expect((view.getByTestId("expression-add-menu") as HTMLButtonElement).disabled).toBe(false);
  });
  it("받아 둔 것 없이 실패: 위 한 줄과 ＋만 서고 「아직 팀 그림이 없어요」는 말하지 않는다", async () => {
    const store = failing(storeOf(ITEMS));
    const { view } = await mount(store);
    expect(store.getSnapshot().status).toBe("error");
    expect(view.getByTestId("team-expressions-error")).toBeTruthy();
    expect(view.queryByTestId("expression-grid")).toBeNull();
    expect(view.container.textContent).not.toContain("아직 팀 그림이 없어요");
    expect((view.getByTestId("expression-add-menu") as HTMLButtonElement).disabled).toBe(false);
  });
  it("받아 둔 목록이 있으면 읽기가 실패해도 격자는 그대로 서고 띠도 그대로다", async () => {
    const store = storeOf(ITEMS);
    const { view } = await mount(store);
    store.transport.json = vi.fn().mockRejectedValue(new Error("down"));
    await act(() => store.refresh());
    expect(view.getByTestId("team-expressions-error")).toBeTruthy();
    expect(sectionsOf(view).length).toBeGreaterThan(0);
    expect(view.getByTestId("expression-set-strip")).toBeTruthy();
  });
});

describe("세트 띠", () => {
  // jsdom 에는 레이아웃이 없어서 구역의 윗머리를 데이터 열쇠로 정해 둔다(실제 스크롤 위치는 캡처로 잰다).
  const TOPS: Record<string, number> = { recent: 0, favorites: 120, "set:chi": 240, "set:dam": 360, other: 480 };
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { return TOPS[(this as HTMLElement).dataset.section ?? ""] ?? 0; } });
  });
  afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, "offsetTop"); });

  it("최근 · 즐겨찾기 · 세트마다 첫 그림 · 기타 순이고 끝에 ＋가 선다. 별표가 없으면 ★ 칸은 숨는다", async () => {
    const { view } = await mount(storeOf(ITEMS, { used: ["solo"], starred: ["dam_a"] }));
    expect(stripLabels(view)).toEqual(["Frequent & recent", "Favorites", "chi", "농담곰", "Other"]);
    const strip = stripOf(view);
    const last = [...strip.querySelectorAll("button")].at(-1)!;
    expect(last.getAttribute("data-testid")).toBe("expression-add-menu");
    // 세트 단추는 그 세트의 첫 그림이다(이름이 아니라 그림).
    expect(strip.querySelector("[data-strip='set:dam'] [data-expression-name]")?.getAttribute("data-expression-name")).toBe("dam_a");
    cleanup(); localStorage.clear();
    const bare = await mount(storeOf(ITEMS));
    expect(stripLabels(bare.view)).toEqual(["chi", "농담곰", "Other"]);
    expect(bare.view.container.querySelector("[data-strip='favorites']")).toBeNull();
    expect(bare.view.container.querySelector("[data-strip='recent']")).toBeNull();
  });

  it("단추를 누르면 그 구역으로 스크롤하고 지금 구역을 표시한다", async () => {
    const { view } = await mount(storeOf(ITEMS, { used: ["solo"], starred: ["dam_a"] }));
    const grid = view.getByTestId("expression-grid");
    expect(grid.scrollTop).toBe(0);
    const current = () => [...stripOf(view).querySelectorAll("[data-strip]")].filter((button) => button.getAttribute("aria-current") === "true").map((button) => button.getAttribute("data-strip"));
    expect(current()).toEqual(["recent"]);
    fireEvent.click(stripOf(view).querySelector("[data-strip='set:dam']")!);
    expect(grid.scrollTop).toBe(TOPS["set:dam"]);
    expect(current()).toEqual(["set:dam"]);
    fireEvent.click(stripOf(view).querySelector("[data-strip='favorites']")!);
    expect(grid.scrollTop).toBe(TOPS.favorites);
    expect(current()).toEqual(["favorites"]);
    fireEvent.click(within(stripOf(view)).getByLabelText("Other"));
    expect(grid.scrollTop).toBe(TOPS.other);
    expect(current()).toEqual(["other"]);
  });

  it("가리키던 구역이 사라지면(별표를 뺀 뒤) 지금 구역 표시는 첫 구역으로 돌아간다", async () => {
    const { view } = await mount(storeOf(ITEMS, { used: ["solo"], starred: ["dam_a"] }));
    fireEvent.click(stripOf(view).querySelector("[data-strip='favorites']")!);
    expect(stripOf(view).querySelector("[aria-current='true']")?.getAttribute("data-strip")).toBe("favorites");
    fireEvent.contextMenu(view.getAllByRole("button", { name: "dam_a 메시지에 넣기" })[0]!);
    fireEvent.click(await view.findByRole("menuitem", { name: "Remove from favorites" }));
    expect(view.container.querySelector("[data-strip='favorites']")).toBeNull();
    expect([...stripOf(view).querySelectorAll("[aria-current='true']")].map((button) => button.getAttribute("data-strip"))).toEqual(["recent"]);
  });

  it("사람이 직접 스크롤하면 지금 구역이 따라간다(눌러서 건너뛴 직후의 잠깐을 빼고)", async () => {
    const { view } = await mount(storeOf(ITEMS, { used: ["solo"], starred: ["dam_a"] }));
    const grid = view.getByTestId("expression-grid");
    const current = () => stripOf(view).querySelector("[aria-current='true']")?.getAttribute("data-strip");
    grid.scrollTop = 250;
    fireEvent.scroll(grid);
    expect(current()).toBe("set:chi");
    grid.scrollTop = 365;
    fireEvent.scroll(grid);
    expect(current()).toBe("set:dam");
    // 맨 아래까지 내려오면 마지막 구역이 지금 구역이다(마지막 구역들은 윗머리가 맨 위에 못 닿을 수 있다). 스크롤할 수 있는 상자에서만 그렇게 읽는다.
    Object.defineProperty(grid, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(grid, "clientHeight", { configurable: true, value: 320 });
    grid.scrollTop = 280;
    fireEvent.scroll(grid);
    expect(current()).toBe("other");
    grid.scrollTop = 130;
    fireEvent.scroll(grid);
    expect(current()).toBe("favorites");
  });
});

describe("방향키", () => {
  const cells = (view: ReturnType<typeof render>) => [...view.getByTestId("expression-grid").querySelectorAll<HTMLButtonElement>("button")];
  const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
  const focused = () => (document.activeElement?.getAttribute("aria-label") ?? "").replace(" 메시지에 넣기", "");

  it("한 칸만 탭 순서에 있고(roving), 방향키는 구역을 이어 붙인 격자 위에서 움직인다", async () => {
    const { view } = await mount(storeOf(ITEMS));
    expect(cells(view).map((cell) => cell.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    cells(view)[0]!.focus();
    expect(focused()).toBe("chi_a");
    press("ArrowRight"); expect(focused()).toBe("chi_b");
    press("ArrowRight"); expect(focused()).toBe("dam_a"); // 구역 끝에서 오른쪽 = 다음 구역 처음
    press("ArrowDown"); expect(focused()).toBe("solo"); // dam 은 한 줄이라 마지막 줄 -> 다음 구역 같은 열(없으면 그 줄의 끝)
    press("ArrowUp"); expect(focused()).toBe("dam_a");
    press("End"); expect(focused()).toBe("solo");
    press("Home"); expect(focused()).toBe("chi_a");
    // 탭 순서의 칸이 따라 움직인다: 지금 칸만 tabIndex 0.
    expect(cells(view).map((cell) => cell.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    press("ArrowLeft"); expect(focused()).toBe("chi_a"); // 처음에서 왼쪽 = 그 자리
    press("ArrowRight"); press("ArrowRight");
    expect(cells(view).map((cell) => cell.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
  });

  it("검색 칸에서 아래 화살표를 누르면 탭 순서에 있는 칸으로 들어간다 - 다른 키와 빈 격자에서는 아무 일도 없다", async () => {
    const { view } = await mount(storeOf(ITEMS));
    const search = view.getByLabelText("Search emoticons");
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cells(view)[0]);
    // 칸을 옮겨 둔 뒤 검색 칸에서 다시 들어오면 그 칸이다(탭 순서의 칸).
    press("ArrowRight");
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(focused()).toBe("chi_b");
    cleanup();
    const empty = await mount(storeOf([]));
    const box = empty.view.getByLabelText("Search emoticons");
    box.focus();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(document.activeElement).toBe(box);
  });

  it("칸은 진짜 단추라서 Enter·Space 가 누름(고르기)이고, 메뉴 안의 방향키는 격자를 움직이지 않는다", async () => {
    const { view, onPick } = await mount(storeOf(ITEMS));
    const cell = cells(view)[0]!;
    expect(cell.tagName).toBe("BUTTON");
    expect(cell.getAttribute("type")).toBe("button");
    cell.focus();
    fireEvent.click(cell);
    expect(onPick).toHaveBeenCalledWith(":chi_a:");
    // 항목 메뉴는 포털이지만 React 이벤트는 격자까지 올라온다 - 메뉴의 ArrowDown 이 격자 초점을 옮기면 안 된다.
    fireEvent.contextMenu(cell);
    const menu = await view.findByRole("menu");
    fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0]!, { key: "ArrowDown" });
    expect(cells(view).map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
  });
});

describe("칸 메뉴와 즐겨찾기", () => {
  it("메뉴는 즐겨찾기 · 신고하기 · 삭제하기이고, 즐겨찾기는 이 기기에 저장되며 구역과 띠의 ★가 따라 선다", async () => {
    const store = storeOf(ITEMS);
    const { view } = await mount(store);
    expect(sectionsOf(view).map((section) => section.getAttribute("data-section"))).toEqual(["set:chi", "set:dam", "other"]);
    const cell = () => view.getByRole("button", { name: "dam_b 메시지에 넣기" });
    fireEvent.contextMenu(cell());
    expect((await view.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Add to favorites", "신고하기", "삭제하기"]);
    fireEvent.click(view.getByRole("menuitem", { name: "Add to favorites" }));
    // 저장: 이 기기 · 이 워크스페이스 · 이 사람의 키에, 서버로는 아무것도 나가지 않는다.
    expect(JSON.parse(localStorage.getItem(favoritesKey)!)).toEqual({ v: 1, workspaceId: WS, memberId: ME, ids: [idOf("dam_b")] });
    expect(shape(view)[0]).toEqual(["favorites", "Favorites", ["dam_b"]]);
    expect(stripLabels(view)[0]).toBe("Favorites");
    // 같은 그림이 즐겨찾기와 세트에 한 번씩 선다. 세트 쪽 칸의 메뉴는 이제 「빼기」다.
    expect(view.getAllByRole("button", { name: "dam_b 메시지에 넣기" })).toHaveLength(2);
    fireEvent.contextMenu(view.getAllByRole("button", { name: "dam_b 메시지에 넣기" })[1]!);
    fireEvent.click(await view.findByRole("menuitem", { name: "Remove from favorites" }));
    expect(JSON.parse(localStorage.getItem(favoritesKey)!).ids).toEqual([]);
    expect(sectionsOf(view).map((section) => section.getAttribute("data-section"))).toEqual(["set:chi", "set:dam", "other"]);
    expect(view.container.querySelector("[data-strip='favorites']")).toBeNull();
  });

  it("관리 기능은 그대로다: 칸 메뉴의 신고하기가 확인 단계를 세운다", async () => {
    const { view } = await mount(storeOf(ITEMS));
    fireEvent.contextMenu(view.getByRole("button", { name: "solo 메시지에 넣기" }));
    fireEvent.click(await view.findByRole("menuitem", { name: "신고하기" }));
    expect(view.getByTestId("expression-confirm")).toBeTruthy();
    expect(view.queryByTestId("expression-grid")).toBeNull();
  });
});

// 칸 메뉴의 키보드 길(검수 7a H1, #5486)의 jsdom 층. 실제 엔진·실제 키 누름(WebKit·Chromium)은 `ExpressionGrid.keyboardMenu.browser.test.ts` 가 재고, 엔진이 없는 레인에서도
// 칸의 `onKeyDown` 이 지켜지도록 같은 약속을 합성 keydown 으로 한 번 더 건다(사이드바 행 메뉴 시험과 같은 모양). 오른쪽 클릭을 합성하는 위의 시험들은 이 키 처리를 지나지 않는다.
describe("칸 메뉴의 키보드 길 (jsdom 층, #5486 H1)", () => {
  it("Shift+F10 이 칸 메뉴를 열고 기본 동작을 가져가며, Esc 로 닫으면 초점이 그 칸으로 돌아온다. 다른 키·조합은 열지 않는다", async () => {
    const { view } = await mount(storeOf(ITEMS));
    const cell = view.getByRole("button", { name: "dam_b 메시지에 넣기" });
    cell.focus();
    // 이 줄이 없으면 아래 「열렸다」는 「keydown 을 쏘면 늘 열린다」로도 통과한다.
    for (const init of [{ key: "F10" }, { key: "F10", shiftKey: true, ctrlKey: true }, { key: "m" }, { key: "ArrowRight" }]) {
      fireEvent.keyDown(cell, init);
      expect(view.queryByRole("menu"), JSON.stringify(init)).toBeNull();
    }
    cell.focus();
    const summon = createEvent.keyDown(cell, { key: "F10", shiftKey: true });
    fireEvent(cell, summon);
    expect(summon.defaultPrevented).toBe(true);
    expect((await view.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Add to favorites", "신고하기", "삭제하기"]);
    await waitFor(() => expect(view.getByRole("menu").contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("전용 메뉴 키(ContextMenu)도 같은 문이다", async () => {
    const { view } = await mount(storeOf(ITEMS));
    const cell = view.getByRole("button", { name: "solo 메시지에 넣기" });
    cell.focus();
    fireEvent.keyDown(cell, { key: "ContextMenu" });
    expect((await view.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Add to favorites", "신고하기", "삭제하기"]);
  });
});

describe("즐겨찾기 저장 - 이 기기 · 이 워크스페이스 · 이 사람", () => {
  const empty = { json: async () => ({ ...FIXTURE_LIST, version: "9", items: [] }), image: async () => "data:image/png;base64,AA==" } as ExpressionTransport;
  it("켜고 끄면 저장되고, 같은 사람이 다시 열면 돌아오며, 구독자에게 알린다", () => {
    const store = new ExpressionStore(WS, ME, empty);
    const listener = vi.fn();
    store.subscribe(listener);
    store.toggleFavorite("a"); store.toggleFavorite("b");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().favorites.ids).toEqual(["a", "b"]);
    expect(JSON.parse(localStorage.getItem(favoritesKey)!).ids).toEqual(["a", "b"]);
    expect(new ExpressionStore(WS, ME, empty).getSnapshot().favorites.ids).toEqual(["a", "b"]);
    store.toggleFavorite("a");
    expect(new ExpressionStore(WS, ME, empty).getSnapshot().favorites.ids).toEqual(["b"]);
  });
  it("다른 사람·다른 워크스페이스에는 보이지 않고, 깨진 저장값과 저장소 오류는 빈 목록으로 견딘다", () => {
    new ExpressionStore(WS, ME, empty).toggleFavorite("a");
    expect(new ExpressionStore(WS, "someone-else", empty).getSnapshot().favorites.ids).toEqual([]);
    expect(new ExpressionStore("other-workspace", ME, empty).getSnapshot().favorites.ids).toEqual([]);
    localStorage.setItem(favoritesKey, "{not json");
    expect(new ExpressionStore(WS, ME, empty).getSnapshot().favorites.ids).toEqual([]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const store = new ExpressionStore(WS, ME, empty);
    store.toggleFavorite("z");
    expect(store.getSnapshot().favorites.ids).toEqual(["z"]); // 저장소가 없어도 이 세션에서는 켜진다
    vi.restoreAllMocks();
  });
  it("정리된(dispose) 저장소는 더 받지 않는다", () => {
    const store = new ExpressionStore(WS, ME, empty);
    store.dispose();
    store.toggleFavorite("a");
    expect(store.getSnapshot().favorites.ids).toEqual([]);
    expect(localStorage.getItem(favoritesKey)).toBeNull();
  });
});
