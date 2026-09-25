import { describe, expect, it } from "vitest";
import { DEFAULT_DENSITY_ID, DENSITY, DENSITY_IDS, DENSITY_TOUCH_FLOOR, normalizeDensity } from "./density";

describe("밀도 두 단계(ADR-0189 D4)", () => {
  it("comfortable이 기본이고 두 단계뿐이다", () => {
    expect(DENSITY_IDS).toEqual(["comfortable", "compact"]);
    expect(DEFAULT_DENSITY_ID).toBe("comfortable");
  });

  it("compact는 모든 값을 줄이거나 그대로 둔다 — 늘리지 않는다", () => {
    for (const key of Object.keys(DENSITY.comfortable) as (keyof typeof DENSITY.comfortable)[]) {
      expect([key, DENSITY.compact[key] <= DENSITY.comfortable[key]]).toEqual([key, true]);
    }
  });

  it("폰 목록 행은 두 단계 모두 터치 하한 44 이상이다", () => {
    for (const id of DENSITY_IDS) expect(DENSITY[id].phoneListRow).toBeGreaterThanOrEqual(DENSITY_TOUCH_FLOOR);
    expect(DENSITY.compact.phoneListRow).toBe(DENSITY_TOUCH_FLOOR);
  });

  it("옛 이름을 방어적으로 읽는다", () => {
    expect(normalizeDensity("comfy")).toBe("comfortable");
    expect(normalizeDensity("spacious")).toBe("comfortable");
    expect(normalizeDensity("compact")).toBe("compact");
    expect(normalizeDensity(undefined)).toBe("comfortable");
    expect(normalizeDensity(7)).toBe("comfortable");
  });
});
