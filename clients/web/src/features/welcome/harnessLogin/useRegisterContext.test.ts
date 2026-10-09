import { describe, expect, it } from "vitest";
import { registerSurfaceEligible } from "./useRegisterContext";

// #3567: 맥락이 null이면 로그인 모달은 「연결됐어요」에서 닫히고, D15 `register`와 CLI
// `add-json`은 이 맥락의 `deps`로만 불리므로 둘 다 일어나지 않는다.
describe("registerSurfaceEligible (#3567)", () => {
  it("never stands while the build flag is off, whatever the entry says", () => {
    for (const entry of ["rows", "server-off", "pending", "denied", "hidden", "desktop-only"] as const) {
      expect(registerSurfaceEligible(false, entry), entry).toBe(false);
    }
  });

  it("stands with the flag on only where it stood before", () => {
    expect(registerSurfaceEligible(true, "rows")).toBe(true);
    expect(registerSurfaceEligible(true, "server-off")).toBe(true);
    for (const entry of ["pending", "denied", "hidden", "desktop-only"] as const) {
      expect(registerSurfaceEligible(true, entry), entry).toBe(false);
    }
  });
});
