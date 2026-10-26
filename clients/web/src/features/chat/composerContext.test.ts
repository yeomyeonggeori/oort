import { describe, expect, it } from "vitest";
import { wordRangeAt } from "./composerFormat";
import { composerContextBandShows, composerContextHost } from "./composerContext";

describe("wordRangeAt (서식 단추의 선택 없음 처리)", () => {
  it.each([
    ["낱말 가운데", "배포 롤백 근거", 4, { start: 3, end: 5 }],
    ["낱말 끝", "배포 롤백", 2, { start: 0, end: 2 }],
    ["낱말 바로 뒤의 공백은 왼쪽 낱말", "배포  롤백", 2, { start: 0, end: 2 }],
    ["낱말에서 먼 공백은 오른쪽 낱말", "배포  롤백", 3, { start: 4, end: 6 }],
    ["맨 앞 공백은 오른쪽 낱말", "  배포", 0, { start: 2, end: 4 }],
    ["줄바꿈을 경계로 본다", "가\n나다", 3, { start: 2, end: 4 }],
  ])("%s", (_name, value, caret, expected) => {
    expect(wordRangeAt(value, caret)).toEqual(expected);
  });

  it("공백뿐이거나 빈 글이면 null", () => {
    expect(wordRangeAt("", 0)).toBeNull();
    expect(wordRangeAt("  \n ", 2)).toBeNull();
  });
});

describe("맥락 띠 판정", () => {
  it("에이전트이고 hostOnline 이 false 일 때만 칩이 있다(정상은 되풀이하지 않는다, #4044)", () => {
    expect(composerContextHost({ kind: "agent", hostOnline: true })).toBeNull();
    expect(composerContextHost({ kind: "agent", hostOnline: false })?.online).toBe(false);
    expect(composerContextHost({ kind: "agent" })).toBeNull();
    expect(composerContextHost({ kind: "human", hostOnline: true })).toBeNull();
    expect(composerContextHost(null)).toBeNull();
  });

  it("루틴형 에이전트는 「연결 안 됨」 대신 「다음 확인 때 가져가요(보통 N분 안)」로 말한다(#4619 D)", () => {
    const routine = { typicalMinutes: 15 };
    const off = composerContextHost({ kind: "agent", hostOnline: false }, routine);
    expect(off).toEqual({
      online: false,
      text: "다음 확인 때 가져가요(보통 15분 안)",
      routine: true,
    });
    expect(off?.text).not.toContain("연결 안 됨");
    // 박자를 모르면 그대로다(지어내지 않는다).
    expect(composerContextHost({ kind: "agent", hostOnline: false })?.text).toBe(
      "일하는 곳 · 연결 안 됨"
    );
    // 박자가 있어도 연결됨·모름·사람에게는 칩이 없다.
    expect(composerContextHost({ kind: "agent", hostOnline: true }, routine)).toBeNull();
    expect(composerContextHost({ kind: "agent" }, routine)).toBeNull();
    expect(composerContextHost({ kind: "human", hostOnline: false }, routine)).toBeNull();
    expect(composerContextHost(null, routine)).toBeNull();
  });

  it("인용이나 칩이 있을 때만 띠가 선다", () => {
    const host = composerContextHost({ kind: "agent", hostOnline: false });
    expect(composerContextBandShows({ quoting: false, host: null })).toBe(false);
    expect(composerContextBandShows({ quoting: true, host: null })).toBe(true);
    expect(composerContextBandShows({ quoting: false, host })).toBe(true);
  });
});
