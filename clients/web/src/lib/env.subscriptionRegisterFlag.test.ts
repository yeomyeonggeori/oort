import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_REGISTER_BUILD_FLAG, subscriptionRegisterBuildFlagOn } from "./env";

// #3567: 로그인 뒤 「에이전트로 만들기」(D15 register + CLI add-json)는 기본 꺼짐이다.
// 구독 줄 플래그(`VITE_MOMO_SUBSCRIPTION_AGENTS`)와 방향이 반대다: 없음·빈값은 끔, 켬 값만 켬.
describe("VITE_MOMO_SUBSCRIPTION_REGISTER (#3567)", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["0", false],
    ["false", false],
    ["ture", false],
    ["TRUE", false],
    ["on", false],
    ["1", true],
    ["true", true],
    [" 1 ", true],
  ])("%j → %s", (raw, expected) => {
    expect(subscriptionRegisterBuildFlagOn(raw)).toBe(expected);
  });

  it("is off in a build that sets nothing", () => {
    expect(SUBSCRIPTION_REGISTER_BUILD_FLAG).toBe(false);
  });
});
