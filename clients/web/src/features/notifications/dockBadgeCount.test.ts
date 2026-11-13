import { describe, expect, it } from "vitest";
import { dockBadgeCount } from "./dockBadgeCount";

describe("dockBadgeCount (#3339)", () => {
  it("DM 스위치를 끄고 따라가는 스레드의 답글이 없으면 needsMe 수와 정확히 같다", () => {
    for (const n of [0, 1, 4, 37]) {
      expect(dockBadgeCount(n, { dockBadge: true, dockDms: false }, 9, 0)).toBe(n);
    }
  });

  it("독 배지를 끄면 0이다(답글 몫까지)", () => {
    expect(dockBadgeCount(4, { dockBadge: false, dockDms: true }, 9, 5)).toBe(0);
  });

  it("DM 합산을 켠 사람만 안 읽은 DM이 더해진다", () => {
    expect(dockBadgeCount(4, { dockBadge: true, dockDms: true }, 3, 0)).toBe(7);
  });

  it("따라가는 스레드의 답글 몫은 DM 스위치와 무관하게 더해진다 (#5660)", () => {
    expect(dockBadgeCount(0, { dockBadge: true, dockDms: false }, 9, 2)).toBe(2);
    expect(dockBadgeCount(4, { dockBadge: true, dockDms: true }, 3, 2)).toBe(9);
  });
});
