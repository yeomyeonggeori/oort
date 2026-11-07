// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caretOnFirstVisualLine, isCaretOnFirstLine } from "./caretLine";

// =============================================================================
// 캐럿이 입력칸의 첫 **화면** 줄에 있는가 (#5489 M1). 줄바꿈만 보면 길게 감긴 한 문단의 아래 줄에서도 「첫 줄」이라고 답해 ↑ 가 추천 줄로 새 버린다.
//
// jsdom 에는 배치가 없어서(모든 상자가 0) 감김을 잴 수 없다. 이 파일은 두 가지를 한다:
//   1) 순수 판정 `isCaretOnFirstLine` 을 숫자로 잰다(같은 줄 / 줄 높이만큼 아래 / 이모지가 든 줄의 몇 px 어긋남 / 문턱 경계 / 배치 없음).
//   2) 거울을 만들고 지우는 배선 `caretOnFirstVisualLine` 을 **가짜 배치**(10자마다 감김, 줄 20px)로 잰다. 진짜 엔진의 감김은 `caretLine.browser.test.ts` 가 잰다.
// =============================================================================

describe("isCaretOnFirstLine: 두 윗선의 차이로 같은 화면 줄인지 읽는다", () => {
  const mark = { markHeight: 16 };

  it("윗선이 같으면 첫 줄이고, 줄이 하나 내려가면(줄 높이 이상 벌어지면) 아니다", () => {
    expect(isCaretOnFirstLine({ startTop: 100, caretTop: 100, ...mark })).toBe(true);
    expect(isCaretOnFirstLine({ startTop: 100, caretTop: 124, ...mark })).toBe(false);
    expect(isCaretOnFirstLine({ startTop: 100, caretTop: 172, ...mark })).toBe(false);
  });

  it("이모지가 든 줄처럼 기준선이 몇 px 어긋나도 같은 줄이다 (표지 높이의 절반이 문턱)", () => {
    expect(isCaretOnFirstLine({ startTop: 100, caretTop: 103, ...mark })).toBe(true);
    expect(isCaretOnFirstLine({ startTop: 100, caretTop: 107.9, ...mark })).toBe(true);
    expect(isCaretOnFirstLine({ startTop: 100, caretTop: 108, ...mark })).toBe(false);
  });

  it("배치가 없으면(모든 값이 0) 같은 줄이다: 줄바꿈 검사의 답이 그대로 남는다", () => {
    expect(isCaretOnFirstLine({ startTop: 0, caretTop: 0, markHeight: 0 })).toBe(true);
  });
});

describe("caretOnFirstVisualLine: 거울 배선 (가짜 배치: 10자마다 한 줄, 줄 간격 20px)", () => {
  const CHARS_PER_LINE = 10;
  const LINE = 20;
  let rectCalls = 0;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    rectCalls = 0;
    // 거울의 표지(`span`)만 앞 글의 길이로 윗선을 정한다. 나머지 상자는 jsdom 기본(0)이다.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.parentElement?.hasAttribute("data-composer-format-mirror")) {
        rectCalls += 1;
        const before = this.previousSibling?.textContent ?? "";
        const top = Math.floor(before.length / CHARS_PER_LINE) * LINE;
        return { x: 0, y: top, top, left: 0, right: 0, bottom: top + 16, width: 0, height: 16, toJSON: () => ({}) } as DOMRect;
      }
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    textarea = document.createElement("textarea");
    document.body.append(textarea);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function caretAt(value: string, position: number): boolean {
    textarea.value = value;
    textarea.setSelectionRange(position, position);
    return caretOnFirstVisualLine(textarea);
  }

  it("줄바꿈 없이 감긴 글: 첫 화면 줄의 캐럿은 참이고, 둘째·셋째 화면 줄의 캐럿은 거짓이다", () => {
    const wrapped = "회의가 길어져서 오늘은 늦을 것 같아요 ㅋㅋㅋ"; // 줄바꿈 없음, 가짜 배치로 3줄
    expect(wrapped.includes("\n")).toBe(false);
    expect(caretAt(wrapped, 0)).toBe(true);
    expect(caretAt(wrapped, 6)).toBe(true);
    expect(caretAt(wrapped, 12)).toBe(false);
    expect(caretAt(wrapped, wrapped.length)).toBe(false);
  });

  it("앞에 줄바꿈이 있으면 거울을 만들지 않고 거짓이다 (싼 검사가 먼저)", () => {
    expect(caretAt("첫 줄\nㅋㅋㅋ", 6)).toBe(false);
    expect(rectCalls).toBe(0);
    // 줄바꿈 뒤에 캐럿이 있어도 그 앞에 줄바꿈이 없으면(첫 줄 끝) 참이다.
    expect(caretAt("첫 줄\nㅋㅋㅋ", 3)).toBe(true);
  });

  it("거울은 재고 나면 문서에서 지워진다", () => {
    caretAt("가나다라마바사아자차카타파하", 14);
    expect(document.querySelector("[data-composer-format-mirror]")).toBeNull();
  });
});
