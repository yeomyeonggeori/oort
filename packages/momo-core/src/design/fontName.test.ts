import { describe, expect, it } from "vitest";
import { FONT_NAME_MAX, FONT_NAME_PATTERN, normalizeFontName, parseFontName } from "./fontName";

// 규칙의 정본은 이 모듈이다(AP-1a #4186). 웹 `userFont.test.ts`가 다시 내보낸 같은 함수를
// 한 번 더 재고, 부트 스크립트와의 문자열 일치는 웹 시험이 지킨다.

describe("fontName (core)", () => {
  it("허용 목록 식과 길이 상한은 부트 스크립트가 옮겨 쓰는 값이다", () => {
    expect(FONT_NAME_PATTERN).toBe("^[\\p{L}\\p{M}\\p{N} ._+&-]+$");
    expect(FONT_NAME_MAX).toBe(64);
  });

  it("실제 글꼴 이름(한글 포함)을 받고 공백을 접는다", () => {
    for (const name of ["Pretendard", "SF Mono", "D2Coding", "나눔고딕", "Fira Code-Retina"]) {
      expect(parseFontName(name)).toEqual({ ok: true, name });
    }
    expect(parseFontName("  SF   Mono \n")).toEqual({ ok: true, name: "SF Mono" });
  });

  it("빈 입력과 문자열이 아닌 값은 「기본」이다", () => {
    for (const raw of ["", "   ", undefined, null, 42, {}]) {
      expect(parseFontName(raw)).toEqual({ ok: true, name: undefined });
    }
  });

  it("따옴표를 닫을 수 있는 글자는 거절한다 (조용히 깎지 않는다)", () => {
    for (const bad of ['A"B', "A;B", "A{B", "A}B", "A(B", "A\\B", "A/B", "url(https://x.test/a)", "x\"; } body { y"]) {
      expect(parseFontName(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "chars" });
    }
  });

  it("공백을 접은 뒤 길이로 잰다", () => {
    expect(parseFontName("a".repeat(FONT_NAME_MAX))).toEqual({ ok: true, name: "a".repeat(FONT_NAME_MAX) });
    expect(parseFontName("a".repeat(FONT_NAME_MAX + 1))).toEqual({ ok: false, reason: "long" });
  });

  it("normalizeFontName은 거절을 undefined로 읽는다", () => {
    expect(normalizeFontName("Pretendard")).toBe("Pretendard");
    expect(normalizeFontName('x"; y')).toBeUndefined();
    expect(normalizeFontName(7)).toBeUndefined();
  });
});
