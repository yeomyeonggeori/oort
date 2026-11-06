// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, waitFor, within, type RenderResult } from "@testing-library/react";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { TeamExpressionsPanel } from "./TeamExpressionsPanel";

// =============================================================================
// #5279 C: 팀 그림 목록을 못 읽었을 때. 스토어가 오류 객체를 삼키던 상태(`status: "error"`)가 객체를 들고 다니게 되어, 같은 실패 줄이 원인
// (오프라인 / 서버에 닿지 못함 / 그 밖)마다 다른 이유를 말한다. 그리고 이미 받아 둔 목록은 실패가 가리지 않는다(#5242 규칙): 한 줄이 위에서 말하고
// 목록은 그대로 서 있다. 받아 둔 것이 없을 때만 한 줄뿐이다(「아직 팀 그림이 없어요」라는 거짓을 말하지 않는다).
// =============================================================================

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]) }));

let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
});
let onLine: MockInstance<() => boolean>;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onLine.mockRestore();
});

function makeStore() {
  return new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
}
function mountPanel(store: ExpressionStore): RenderResult {
  return render(
    <LocaleProvider locale={ko}>
      <ExpressionsContext.Provider value={store}>
        <TeamExpressionsPanel purpose="insert" onPick={() => {}} />
      </ExpressionsContext.Provider>
    </LocaleProvider>
  );
}
// 목록은 그림 격자다(owner 2026-11-07, #5453): 칸 하나가 단추 하나다.
const rowCount = (view: RenderResult) => within(view.getByTestId("expression-grid")).getAllByRole("button").length;
const noteText = (view: RenderResult) => view.getByTestId("team-expressions-error").textContent ?? "";

describe("팀 그림 목록 읽기 실패 (#5279 C)", () => {
  const causes: [string, () => unknown, boolean, string][] = [
    ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요."],
    ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
    ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
  ];

  it("받아 둔 목록이 있으면 목록은 그대로 서고 위 한 줄이 원인마다 다른 이유를 말한다. 상태 코드는 없다", async () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      const store = makeStore();
      await store.refresh();
      const view = mountPanel(store);
      const before = rowCount(view);
      expect(before, name).toBeGreaterThan(0);
      expect(view.queryByTestId("team-expressions-error"), name).toBeNull();

      store.transport.json = vi.fn().mockRejectedValue(failure());
      await act(() => store.refresh());

      expect(noteText(view), name).toContain(`팀 그림을 불러오지 못했어요. ${reason}`);
      expect(noteText(view), name).not.toMatch(/\d{3}/);
      // 받아 둔 목록을 실패로 덮지 않는다.
      expect(rowCount(view), name).toBe(before);
      cleanup();
    }
  });

  it("받아 둔 것이 없는 첫 읽기 실패는 한 줄뿐이고 「아직 팀 그림이 없어요」라고 말하지 않는다. 다시 시도가 목록을 부른다", async () => {
    onLine.mockReturnValue(true);
    const store = makeStore();
    const working = store.transport.json;
    store.transport.json = vi.fn().mockRejectedValue(new NetworkError("unreachable", 15_000));
    await store.refresh();
    const view = mountPanel(store);

    expect(noteText(view)).toContain("팀 그림을 불러오지 못했어요. 서버에 닿지 못했어요.");
    expect(view.queryByTestId("expression-grid")).toBeNull();
    expect(view.queryByText("아직 팀 그림이 없어요")).toBeNull();

    store.transport.json = working;
    fireEvent.click(within(view.getByTestId("team-expressions-error")).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(view.queryByTestId("team-expressions-error")).toBeNull());
    expect(rowCount(view)).toBeGreaterThan(0);
  });
});
