// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FIXTURE_EXPRESSIONS, FIXTURE_LIST, FIXTURE_MEDIA_SET, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import { buildExpressionSections } from "@momo/core/features/expressions/gridSections";
import { emptyExpressionUsage, recordExpressionUse } from "@momo/core/features/expressions/usage";
import type { Expression, ExpressionList } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import type { ExpressionTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { TeamExpressionsPanel } from "./TeamExpressionsPanel";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]), authedResponse: vi.fn() }));

// 이모티콘 탭 맨 위 「자주·최근」 (#5503, owner 2026-11-07): 창을 열면 정지 그림과 GIF 가 섞여 횟수와 최근 점수 순으로 서고,
// 열려 있는 동안에는 차례가 바뀌지 않으며 다시 열 때만 바뀐다. 이 시험은 제공자 없는 고정 영어 사전으로 돈다(이모티콘 보기 맨 위 칸의 이름은 「Frequent & recent」, GIF 보기의 「Recent」는 그대로).

const WS = FIXTURE_WORKSPACE_ID;
const ME = FIXTURE_MEMBER_ID;
const usageKey = `oort.expressions.usage:${WS}:${ME}`;
const NOW = Date.UTC(2026, 10, 7, 12);
const DAY = 86_400_000;
const png = FIXTURE_MEDIA.png.image;
const STILL = { small: { ...png }, large: { ...png }, thumb: { ...png } };
let serial = 500;
const made = (name: string, tags: string[] = [], extra: Partial<Expression> = {}): Expression => ({
  ...FIXTURE_EXPRESSIONS[1], id: `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`, name, displayName: name, tags, kind: "sticker", media: STILL, status: "active", ...extra,
});
// 이모티콘 탭의 보관함은 정지 그림 셋(세트 하나 + 낱개 하나)이고, GIF 둘은 GIF 칸, 작은 팀 이모지 하나는 이모지 칸에 선다.
const dam = ["dam_a", "dam_b"].map((name) => made(name, ["농담곰"]));
const solo = made("solo");
const [wiggle, spin] = ["wiggle", "spin"].map((name) => made(name, [], { media: FIXTURE_MEDIA_SET })) as [Expression, Expression];
const tiny = made("tiny", [], { kind: "emoji" });
const LIBRARY = [...dam, solo, wiggle, spin, tiny];
const damB = dam[1]!;

/** `[등록, 횟수, 며칠 전에 마지막으로]` 로 쓴 기록을 이 기기의 저장소에 둔다(저장소가 열 때 읽는다). */
function seedUsage(rows: ReadonlyArray<readonly [Expression, number, number]>) {
  let usage = emptyExpressionUsage(WS, ME);
  for (const [item, times, daysAgo] of rows) for (let i = 0; i < times; i += 1) usage = recordExpressionUse(usage, item.id, Math.round(NOW - daysAgo * DAY));
  localStorage.setItem(usageKey, JSON.stringify(usage));
}
// 점수 = 횟수 x 0.5^(일 / 7): wiggle 3 x 0.82 = 2.46 · dam_b 0.91 · solo 0.41 · spin 0.14. 작은 이모지(tiny)는 50번 써도 이 칸의 후보가 아니다.
const SEED = [[wiggle, 3, 2], [damB, 1, 1], [solo, 1, 9], [spin, 1, 20], [tiny, 50, 0]] as const;
const FRECENT_ORDER = ["wiggle", "dam_b", "solo", "spin"];

function storeOf(image: ExpressionTransport["image"]) {
  const list: ExpressionList = { ...FIXTURE_LIST, version: "9", items: LIBRARY };
  return new ExpressionStore(WS, ME, { json: async () => list, image });
}
const panel = (store: ExpressionStore, onPickExpression?: (item: Expression) => void, view: "emoticon" | "gif" = "emoticon") => (
  <ExpressionsContext.Provider value={store}>
    <TeamExpressionsPanel purpose="insert" view={view} onPick={() => {}} {...(onPickExpression ? { onPickExpression } : {})} />
  </ExpressionsContext.Provider>
);
async function open(store: ExpressionStore, onPickExpression?: (item: Expression) => void, which: "emoticon" | "gif" = "emoticon") {
  await store.refresh();
  const view = render(panel(store, onPickExpression, which));
  await act(async () => {});
  return view;
}
const cellNames = (section: HTMLElement) => [...section.querySelectorAll<HTMLButtonElement>("button")].map((button) => (button.getAttribute("aria-label") ?? "").replace(" 메시지에 넣기", ""));
const shape = (view: ReturnType<typeof render>) => [...view.container.querySelectorAll<HTMLElement>("[data-section]")].map((section) => [section.getAttribute("data-section"), cellNames(section)]);
const topNames = (view: ReturnType<typeof render>) => cellNames(view.container.querySelector<HTMLElement>("[data-section='recent']")!);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  // 날짜만 고정한다(저장소의 사용 시각과 패널이 열릴 때의 기준 시각). 다른 타이머는 그대로라 waitFor 가 돈다.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("이모티콘 탭 맨 위 「자주·최근」 (#5503)", () => {
  it("창을 열면 맨 위 칸에 정지 그림과 GIF 가 섞여 횟수·최근 점수 순으로 서고, GIF 는 아래 구역에 없다. 작은 이모지는 없다", async () => {
    seedUsage(SEED);
    const image = vi.fn(async (_path: string) => "data:image/png;base64,AA==");
    const view = await open(storeOf(image));
    expect(shape(view)).toEqual([
      ["recent", FRECENT_ORDER],
      ["set:dam", ["dam_a", "dam_b"]], // 보관함은 정지 그림뿐: 맨 위 칸의 GIF·작은 이모지가 아래에 한 번 더 서지 않는다
      ["other", ["solo"]],
    ]);
    // 이름은 사전의 것이고 세트 띠의 첫 단추(시계)가 그 칸으로 건너뛴다. 칸의 id 는 예전 「최근」과 같지만 머리글과 띠 단추의 낭독 이름은 「자주·최근」(en: Frequent & recent)이다.
    expect(view.container.querySelector("[data-section='recent'] p")?.textContent).toBe("Frequent & recent");
    expect(view.container.querySelector("[data-strip='recent']")?.getAttribute("aria-label")).toBe("Frequent & recent");
    expect(view.container.querySelector("[data-strip='recent']")?.getAttribute("title")).toBe("Frequent & recent");
    // 이 칸의 GIF 도 격자의 GIF 와 같은 규칙으로 그린다: 움직이지 않는 썸네일만 받는다(정지 썸네일 규칙을 새로 만들지 않는다).
    await waitFor(() => expect(view.container.querySelectorAll("[data-testid='expression-grid'] img")).toHaveLength(7));
    for (const gif of [wiggle, spin]) {
      const mine = image.mock.calls.map(([path]) => path).filter((path) => path.includes(`/expressions/${gif.id}/`));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((path) => path.includes("size=thumb"))).toBe(true);
    }
  });

  it("머리글은 탭마다 다르다: GIF 보기의 「최근」은 그대로 「Recent」이고(마지막으로 쓴 순), 띠 단추의 이름도 같은 말이다", async () => {
    seedUsage(SEED);
    const view = await open(storeOf(async () => "data:image/png;base64,AA=="), undefined, "gif");
    // GIF 보기: 맨 위 칸은 GIF 끼리 마지막으로 쓴 순(wiggle 2일 전, spin 20일 전)이고 이름은 「Recent」다.
    expect(shape(view)).toEqual([["recent", ["wiggle", "spin"]], ["other", ["spin", "wiggle"]]]);
    expect(view.container.querySelector("[data-section='recent'] p")?.textContent).toBe("Recent");
    expect(view.container.querySelector("[data-strip='recent']")?.getAttribute("aria-label")).toBe("Recent");
    expect(view.container.textContent).not.toContain("Frequent & recent");
  });

  it("GIF 를 누르면 정지 그림처럼 그 등록 자체를 고른다", async () => {
    seedUsage(SEED);
    const picked = vi.fn();
    const view = await open(storeOf(async () => "data:image/png;base64,AA=="), picked);
    fireEvent.click(view.getByRole("button", { name: "wiggle 메시지에 넣기" }));
    expect(picked).toHaveBeenCalledTimes(1);
    expect(picked.mock.calls[0]![0]).toMatchObject({ id: wiggle.id, name: "wiggle" });
  });

  it("열려 있는 동안 보내기가 성공해 기록이 바뀌어도 칸 순서는 그대로이고, 고른 뒤 다시 열 때만 바뀐다", async () => {
    seedUsage(SEED);
    const store = storeOf(async () => "data:image/png;base64,AA==");
    const first = await open(store);
    expect(topNames(first)).toEqual(FRECENT_ORDER);
    // 창이 열린 채 spin 이 방금 두 번 보내졌다(예: 앞서 보낸 글의 성공이 늦게 도착). 기록은 실제로 바뀐다.
    act(() => { store.recordSuccess(":spin:", "receipt-1"); store.recordSuccess(":spin:", "receipt-2"); });
    expect(store.getSnapshot().usage.entries.find((entry) => entry.id === spin.id)?.count).toBe(3);
    // 이 시험이 헛돌지 않는다는 증거: 같은 기록으로 지금 다시 계산하면 차례가 다르다(spin 이 맨 앞).
    const { cache, usage, favorites } = store.getSnapshot();
    const recalculated = buildExpressionSections(cache.items, "emoticon", { query: "", usage, favorites, nowMs: Date.now() })[0]!.items.map((item) => item.name);
    expect(recalculated).not.toEqual(FRECENT_ORDER);
    expect(recalculated[0]).toBe("spin");
    // 그런데 열려 있는 창의 칸 순서는 그대로다.
    expect(topNames(first)).toEqual(FRECENT_ORDER);
    // 닫았다 다시 열면 그때 한 번 새로 계산한다.
    first.unmount();
    const second = await open(store);
    expect(topNames(second)).toEqual(recalculated);
  });
});
