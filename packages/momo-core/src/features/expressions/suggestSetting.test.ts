import { describe, expect, it } from "vitest";
import { EXPRESSION_SUGGEST_DEFAULT_ON, expressionSuggestSetting, restoreExpressionSuggestOn } from "./suggestSetting";

// 「이모티콘 추천」 켜기·끄기 (owner 2026-11-07, #5493): 이 기기 · 이 워크스페이스 · 이 사람의 로컬 값. 기본은 켜짐이고, 끈 것으로 **분명히** 적힌 값만 끔이다.

const WS = "ws-1";
const ME = "me-1";
const stored = (on: boolean) => JSON.parse(JSON.stringify(expressionSuggestSetting(WS, ME, on))) as unknown;

describe("restoreExpressionSuggestOn — 읽기", () => {
  it("한 번도 건드리지 않았으면(저장된 값이 없으면) 켜짐이 기본이다", () => {
    expect(EXPRESSION_SUGGEST_DEFAULT_ON).toBe(true);
    expect(restoreExpressionSuggestOn(null, WS, ME)).toBe(true);
    expect(restoreExpressionSuggestOn(undefined, WS, ME)).toBe(true);
  });

  it("쓴 값을 그대로 읽는다: 끔은 끔, 켬은 켬 (저장소를 지나는 JSON 왕복 뒤에도)", () => {
    expect(restoreExpressionSuggestOn(stored(false), WS, ME)).toBe(false);
    expect(restoreExpressionSuggestOn(stored(true), WS, ME)).toBe(true);
  });

  it("옛 모양·깨진 값·모르는 모양은 모두 켜짐이다 - 못 읽어서 켜 둔 기능이 저절로 꺼지지 않는다", () => {
    const bad: unknown[] = [
      "{not json",
      "off",
      "0",
      0,
      false,
      true,
      [],
      {},
      { on: false },
      { v: 0, workspaceId: WS, memberId: ME, on: false },
      { v: 2, workspaceId: WS, memberId: ME, on: false },
      { v: "1", workspaceId: WS, memberId: ME, on: false },
      { v: 1, workspaceId: WS, memberId: ME },
      { v: 1, workspaceId: WS, memberId: ME, on: "false" },
      { v: 1, workspaceId: WS, memberId: ME, on: 0 },
      { v: 1, workspaceId: WS, memberId: ME, on: null },
    ];
    for (const value of bad) expect(restoreExpressionSuggestOn(value, WS, ME), JSON.stringify(value)).toBe(true);
  });

  it("다른 사람·다른 워크스페이스에서 끈 값은 이 사람에게 닿지 않는다", () => {
    expect(restoreExpressionSuggestOn(expressionSuggestSetting(WS, "someone-else", false), WS, ME)).toBe(true);
    expect(restoreExpressionSuggestOn(expressionSuggestSetting("other-workspace", ME, false), WS, ME)).toBe(true);
    expect(restoreExpressionSuggestOn(expressionSuggestSetting(WS, ME, false), "other-workspace", ME)).toBe(true);
  });
});

describe("expressionSuggestSetting — 쓰기", () => {
  it("저장소에 쓸 값은 모양 1 · 워크스페이스 · 사람 · 켬·끔이고, 켠 것도 적는다", () => {
    expect(expressionSuggestSetting(WS, ME, false)).toEqual({ v: 1, workspaceId: WS, memberId: ME, on: false });
    expect(expressionSuggestSetting(WS, ME, true)).toEqual({ v: 1, workspaceId: WS, memberId: ME, on: true });
  });
});
