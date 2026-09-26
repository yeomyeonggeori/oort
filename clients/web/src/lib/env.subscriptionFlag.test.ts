import { describe, expect, it } from "vitest";
import { subscriptionAgentsBuildFlagOn } from "./env";

// #2870: 구독 줄 빌드 플래그는 기본 켬이고, 서버 킬 스위치
// (`MOMO_SUBSCRIPTION_AGENTS_ENABLED`, config.rs `subscription_agents_switch_on`)와
// 같은 방향으로 읽는다: 없음·빈값은 켬, 켬 값만 켬, 그 밖은 모두 끔.
describe("VITE_MOMO_SUBSCRIPTION_AGENTS (#2870)", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["  ", true],
    ["1", true],
    ["true", true],
    [" 1 ", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["ture", false],
    ["TRUE", false],
  ])("%j → %s", (raw, expected) => {
    expect(subscriptionAgentsBuildFlagOn(raw)).toBe(expected);
  });
});
