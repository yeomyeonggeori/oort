import { describe, expect, it } from "vitest";
import { isAccessWideningRow } from "./actionRows";

describe("접근 범위를 넓히는 행 (#3729)", () => {
  it("channel.create 의 「예」만 강조한다", () => {
    expect(
      isAccessWideningRow("channel.create", { label: "이 에이전트도 참여", value: "예 (승인 채널에 추가)" })
    ).toBe(true);
    expect(
      isAccessWideningRow("channel.create", { label: "이 에이전트도 참여", value: "아니요" })
    ).toBe(false);
  });

  it("다른 행동·다른 행은 강조하지 않는다", () => {
    expect(
      isAccessWideningRow("channel.member.add", { label: "이 에이전트도 참여", value: "예" })
    ).toBe(false);
    expect(isAccessWideningRow("channel.create", { label: "채널", value: "예" })).toBe(false);
  });
});
