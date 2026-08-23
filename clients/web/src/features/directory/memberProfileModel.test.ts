import { describe, expect, it } from "vitest";
import { memberProfileViewState } from "./memberProfileModel";

const base = {
  hasMember: false,
  pending: false,
  failed: false,
  hasCachedRoster: false,
  offline: false,
};

describe("멤버 프로필 상태", () => {
  it.each([
    ["ready", { ...base, hasMember: true }],
    ["loading", { ...base, pending: true }],
    ["error", { ...base, failed: true }],
    ["empty", base],
    ["offline", { ...base, hasMember: true, offline: true }],
  ] as const)("%s 상태를 숨기지 않는다", (expected, input) => {
    expect(memberProfileViewState(input)).toBe(expected);
  });

  it("캐시가 있으면 백그라운드 실패를 빈 오류로 승격하지 않는다", () => {
    expect(
      memberProfileViewState({
        ...base,
        hasMember: true,
        hasCachedRoster: true,
        failed: true,
      })
    ).toBe("ready");
  });
});
