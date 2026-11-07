import { beforeEach, describe, expect, it } from "vitest";
import { MAX_MUTED_KEYWORDS, muteKeywords, mutedKeywords, resetSuggestMuteForTest } from "./suggestMute";

// #5478: 웹 #5476 이 웹에 두었던 「이 낱말 추천 끄기」 기억을 폰이 같이 쓰도록 코어로 올렸다. 규칙(대화마다 따로·빈 낱말 안 담음·상한 넘으면 먼저 끈 것부터 잊음)은 그대로다.
beforeEach(() => resetSuggestMuteForTest());

describe("끈 낱말의 기억", () => {
  it("대화마다 따로다: 한 대화에서 끈 낱말은 다른 대화에 보이지 않는다", () => {
    muteKeywords("ws:a", ["ㅋㅋ"]);
    expect(mutedKeywords("ws:a")).toEqual(["ㅋㅋ"]);
    expect(mutedKeywords("ws:b")).toEqual([]);
  });

  it("이미 끈 낱말을 또 꺼도 한 번만 남고, 끈 차례가 유지되며, 빈 낱말은 담지 않는다", () => {
    muteKeywords("ws:a", ["한숨", "", "ㅋㅋ"]);
    muteKeywords("ws:a", ["한숨"]);
    expect(mutedKeywords("ws:a")).toEqual(["한숨", "ㅋㅋ"]);
  });

  it("상한(200)을 넘으면 가장 먼저 끈 것부터 잊는다", () => {
    const words = Array.from({ length: MAX_MUTED_KEYWORDS + 3 }, (_, index) => `낱말${index}`);
    muteKeywords("ws:a", words);
    const kept = mutedKeywords("ws:a");
    expect(kept).toHaveLength(MAX_MUTED_KEYWORDS);
    expect(kept[0]).toBe("낱말3");
    expect(kept[kept.length - 1]).toBe(`낱말${MAX_MUTED_KEYWORDS + 2}`);
  });

  it("돌려준 목록을 고쳐도 기억은 바뀌지 않는다", () => {
    muteKeywords("ws:a", ["ㅋㅋ"]);
    (mutedKeywords("ws:a") as string[]).push("한숨");
    expect(mutedKeywords("ws:a")).toEqual(["ㅋㅋ"]);
  });
});
