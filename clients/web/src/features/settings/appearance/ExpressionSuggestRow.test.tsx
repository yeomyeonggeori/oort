// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { ExpressionsContext } from "@/features/expressions/context";
import { ExpressionStore } from "@/features/expressions/ExpressionStore";
import { createExpressionFixtureTransport } from "@/features/expressions/transport";
import { readExpressionSuggestOn, resetExpressionSuggestOnForTest } from "@/features/expressions/suggestSetting";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { AppearanceSection } from "../AppearanceSection";
import { ExpressionSuggestRow } from "./ExpressionSuggestRow";

// =============================================================================
// 설정 › 모양 › 대화 표시 › 「이모티콘 추천」 켜기·끄기 (#5493, owner 2026-11-07 「설정에서 다 끌 수도 있어요」).
//   · 기본은 켜짐, 이름·설명은 사전 문구, 누르면 바로 저장(`oort.expressions.suggest:<워크스페이스>:<사람>`)되고 스위치가 따라 선다.
//   · 저장된 끔은 다시 열어도 꺼져 있다. 옛 모양·깨진 값·다른 사람의 값은 켜짐이다. 저장소가 막혀도 스위치는 눌린 대로 선다.
//   · 대화 표시 카드의 「대화 미리보기」 다음에 서고, 보관함 저장소 밖에서는 행을 그리지 않는다.
// 입력창의 추천 줄이 이 값을 따라 걷히고 다시 서는 것은 `chat/composerExpressionSuggest.test.tsx` 가 진짜 입력창으로 잰다.
// =============================================================================

const WS = FIXTURE_WORKSPACE_ID;
const ME = FIXTURE_MEMBER_ID;
const KEY = `oort.expressions.suggest:${WS}:${ME}`;
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;

let korean: AppLocale;
beforeAll(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  localStorage.clear();
  resetExpressionSuggestOnForTest();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  resetExpressionSuggestOnForTest();
});

function inStore(content: ReactNode, store: ExpressionStore | null = new ExpressionStore(WS, ME, createExpressionFixtureTransport(WS, ME))) {
  return (
    <LocaleProvider locale={korean}>
      <ExpressionsContext.Provider value={store}>{content}</ExpressionsContext.Provider>
    </LocaleProvider>
  );
}
const toggle = (view: ReturnType<typeof render>) => view.getByTestId("expression-suggest-toggle");

describe("스위치 - 켜기·끄기", () => {
  it("기본은 켜짐이고, 이름과 설명이 사전 문구로 서고, 누르면 끄고 저장하고 다시 누르면 켠다", () => {
    const view = render(inStore(<ExpressionSuggestRow />));
    const control = view.getByRole("switch", { name: "이모티콘 추천" });
    expect(control).toBe(toggle(view));
    expect(control.getAttribute("aria-checked")).toBe("true");
    const describedBy = control.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("글을 쓰다 멈추면 맞는 이모티콘을 입력창 위에 보여 줘요.");
    expect(localStorage.getItem(KEY)).toBeNull(); // 보기만 해서는 아무것도 쓰지 않는다

    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(stored()).toEqual({ v: 1, workspaceId: WS, memberId: ME, on: false });
    expect(readExpressionSuggestOn(WS, ME)).toBe(false);

    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(stored()).toEqual({ v: 1, workspaceId: WS, memberId: ME, on: true });
    expect(readExpressionSuggestOn(WS, ME)).toBe(true);
  });

  it("저장된 끔은 다시 열어도 꺼져 있고, 옛 모양·깨진 값·다른 사람의 끔은 켜짐이다", () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, workspaceId: WS, memberId: ME, on: false }));
    const first = render(inStore(<ExpressionSuggestRow />));
    expect(toggle(first).getAttribute("aria-checked")).toBe("false");
    first.unmount();

    const readsAs = (raw: string) => {
      localStorage.setItem(KEY, raw);
      const view = render(inStore(<ExpressionSuggestRow />));
      const checked = toggle(view).getAttribute("aria-checked");
      view.unmount();
      return checked;
    };
    expect(readsAs("{not json")).toBe("true");
    expect(readsAs(JSON.stringify({ v: 0, workspaceId: WS, memberId: ME, on: false }))).toBe("true");
    expect(readsAs(JSON.stringify({ v: 1, workspaceId: WS, memberId: "someone-else", on: false }))).toBe("true");
  });

  it("저장소가 막혀 쓰지 못해도 스위치는 눌린 대로 서고, 저장소가 돌아오면 저장소가 다시 쥔다", () => {
    const view = render(inStore(<ExpressionSuggestRow />));
    const control = toggle(view);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    fireEvent.click(control);
    expect(write).toHaveBeenCalled();
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(readExpressionSuggestOn(WS, ME)).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();

    write.mockRestore();
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(stored()).toEqual({ v: 1, workspaceId: WS, memberId: ME, on: true });
  });

  it("끈 값은 이 사람 · 이 워크스페이스에만 닿는다 - 다른 사람의 스위치는 그대로 켜져 있다", () => {
    const first = render(inStore(<ExpressionSuggestRow />));
    fireEvent.click(toggle(first));
    first.unmount();
    const other = render(inStore(<ExpressionSuggestRow />, new ExpressionStore(WS, "someone-else", createExpressionFixtureTransport(WS, ME))));
    expect(toggle(other).getAttribute("aria-checked")).toBe("true");
  });
});

describe("자리", () => {
  it("대화 표시 카드의 「대화 미리보기」 다음에 선다", () => {
    const view = render(inStore(<AppearanceSection />));
    const card = [...view.container.querySelectorAll("section")].find((section) => section.querySelector("h2")?.textContent === "대화 표시");
    expect(card).toBeDefined();
    const labels = [...(card?.querySelectorAll<HTMLElement>(".settings-row") ?? [])].map((row) => row.querySelector(":scope > div > div")?.textContent ?? "?");
    // 미리보기는 그 앞의 선택들을 비추는 행이라 사이에 끼우지 않는다: 링크 미리보기 → 대화 미리보기 → 이모티콘 추천. 앞뒤의 다른 행(글자 크기·대화 밀도·열릴 스레드 배치)은 재지 않는다.
    const at = labels.indexOf("이모티콘 추천");
    expect(at).toBeGreaterThan(0);
    expect(labels.slice(0, at + 1).slice(-3)).toEqual(["링크 미리보기", "대화 미리보기", "이모티콘 추천"]);
    expect(card?.querySelector('[data-testid="expression-suggest-row"]')).not.toBeNull();
  });

  it("보관함 저장소 밖에서는 행을 그리지 않는다 - 눌러도 안 바뀌는 컨트롤을 내보내지 않는다", () => {
    const view = render(inStore(<ExpressionSuggestRow />, null));
    expect(view.queryByTestId("expression-suggest-row")).toBeNull();
    expect(view.queryByRole("switch")).toBeNull();
  });
});
