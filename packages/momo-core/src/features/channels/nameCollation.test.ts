import { describe, expect, it } from "vitest";
import { channelNameCollator, compareChannelNames } from "./nameCollation";

describe("channelNameCollator — 화면 언어 + 숫자 값 차례 (ADR-0225 D12)", () => {
  it("숫자는 값으로 센다: sprint-2 가 sprint-10 앞", () => {
    const sorted = ["sprint-10", "sprint-2", "sprint-1"].sort(compareChannelNames("ko-KR"));
    expect(sorted).toEqual(["sprint-1", "sprint-2", "sprint-10"]);
  });

  // 같은 이름 묶음이 화면 언어마다 다른 차례로 선다 (Node ICU 기준).
  it.each([
    ["ko-KR", ["가나", "漢字", "abc", "かな"]],
    ["en-US", ["abc", "가나", "かな", "漢字"]],
    ["ja-JP", ["abc", "かな", "漢字", "가나"]],
  ])("%s 화면에서의 차례", (locale, expected) => {
    expect(["漢字", "가나", "かな", "abc"].sort(compareChannelNames(locale))).toEqual(expected);
  });

  it("같은 언어면 같은 Collator, 언어가 바뀔 때만 새로 만든다", () => {
    const ko = channelNameCollator("ko-KR");
    expect(channelNameCollator("ko-KR")).toBe(ko);
    const ja = channelNameCollator("ja-JP");
    expect(ja).not.toBe(ko);
    expect(channelNameCollator("ja-JP")).toBe(ja);
  });

  it("알 수 없는 언어 이름이어도 정렬은 돈다", () => {
    expect(["b-10", "b-2"].sort(compareChannelNames("not a locale!"))).toEqual(["b-2", "b-10"]);
  });
});
