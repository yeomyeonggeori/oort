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

  it("인용이나 칩이 있을 때만 띠가 선다", () => {
    const host = composerContextHost({ kind: "agent", hostOnline: false });
    expect(composerContextBandShows({ quoting: false, host: null })).toBe(false);
    expect(composerContextBandShows({ quoting: true, host: null })).toBe(true);
    expect(composerContextBandShows({ quoting: false, host })).toBe(true);
  });
});
