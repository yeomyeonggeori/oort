import { describe, expect, it } from "vitest";
import { dockBadgeCount } from "./dockBadgeCount";

describe("dockBadgeCount (#3339)", () => {
  it("기본 설정에서는 needsMe 수와 정확히 같다(DM은 안 센다)", () => {
    for (const n of [0, 1, 4, 37]) {
      expect(dockBadgeCount(n, { dockBadge: true, dockDm: false }, 9)).toBe(n);
    }
  });

  it("독 배지를 끄면 0이다", () => {
    expect(dockBadgeCount(4, { dockBadge: false, dockDm: true }, 9)).toBe(0);
  });

  it("DM 합산을 켠 사람만 안 읽은 DM이 더해진다", () => {
    expect(dockBadgeCount(4, { dockBadge: true, dockDm: true }, 3)).toBe(7);
  });
});
