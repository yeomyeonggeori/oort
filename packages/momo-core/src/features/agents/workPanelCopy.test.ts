import { describe, expect, it } from "vitest";
import enTimeline from "../../i18n/catalogs/en-US/timeline.json";
import koTimeline from "../../i18n/catalogs/ko-KR/timeline.json";

// =============================================================================
// 작업 패널 사전(`timeline.work*`)의 수·시간·말씨 한 틀 (#5174, 화면 검수 3회차 L1·L2).
//
// 한 화면 안에서 같은 종류의 수·시간이 두 틀로 서던 결함이 사전 문장에서 났다: 「1.2초」와 「12ms」, 「진행 알리기 · 12번」과
// 「읽기 12」, 「oort 호출 재시도 1번」, 승인의 반대 낱말 「거절」(말 사전은 「거부」). 문장 하나씩의 시험은 이미 있다
// (`workHealth.test.ts` · `workTimeline.test.ts`). 여기는 **사전 전체**를 훑어서, 새 문장이 옛 틀로 들어오는 길을 막는다.
// 원문 JSON을 읽는다: 생성물(AST)은 메시지를 인자 없이 말로 풀 수 없다. 코어는 Node 모듈도 `import.meta`도 쓰지 않으므로
// (폰과 공유, `scripts/purity.mjs`) JSON 임포트로 읽는다(`resolveJsonModule`, 다른 코어 시험과 같은 방식).
// =============================================================================

type Locale = "ko-KR" | "en-US";

const CATALOGS: Record<Locale, Record<string, string>> = { "ko-KR": koTimeline, "en-US": enTimeline };

function panelMessages(locale: Locale): [string, string][] {
  return Object.entries(CATALOGS[locale]).filter(([key]) => key.startsWith("timeline.work"));
}

/** 수 자리표시자(`{count, number}` · `{# ...}`)에 곧바로 붙은 꼬리가 있는 문장. */
function withTail(messages: [string, string][], tail: RegExp): string[] {
  return messages.filter(([, text]) => tail.test(text)).map(([key, text]) => `${key}: ${text}`);
}

describe("작업 패널 사전: 같은 종류의 수는 한 틀이다 (L1)", () => {
  it("사전이 비어 있지 않다(양성 대조: 훑는 대상이 실제로 있다)", () => {
    expect(panelMessages("ko-KR").length).toBeGreaterThan(40);
    expect(panelMessages("en-US").length).toBe(panelMessages("ko-KR").length);
  });

  it("한국어: 수 뒤에 셈말 꼬리 「번」이 붙지 않는다(수는 「읽기 12」처럼 이름 뒤 맨 숫자다)", () => {
    expect(withTail(panelMessages("ko-KR"), /\{\w+, number\}\s?번|\d\s?번/)).toEqual([]);
  });

  it("두 언어: 시간은 초·분 한 틀이라 ms 단위가 없다", () => {
    for (const locale of ["ko-KR", "en-US"] as const) {
      expect(withTail(panelMessages(locale), /\{\w+, number\}\s?ms\b|\dms\b/), locale).toEqual([]);
    }
  });

  it("영어: 수 뒤에 「time(s)」 꼬리가 붙지 않는다", () => {
    expect(withTail(panelMessages("en-US"), /(?:\{\w+, number\}|#)\s?times?\b/)).toEqual([]);
  });
});

describe("작업 패널 사전: 승인의 반대는 말 사전의 「거부」다 (L2)", () => {
  it("한국어 문장에 「거절」이 없다", () => {
    expect(withTail(panelMessages("ko-KR"), /거절/)).toEqual([]);
  });
});
