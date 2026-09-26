import { describe, expect, it } from "vitest";
import {
  DOCK_MIN_PX,
  DOCK_RATIO_HIGH,
  DOCK_RATIO_LOW,
  DOCK_ROUTE_FLOOR_PX,
  clampDockRatio,
  dockRatioFromPointer,
  parseDockPrefs,
  serializeDockPrefs,
  toggleDockRatio,
} from "./dockStore";

describe("도크 높이", () => {
  it("더블클릭은 두 단계를 오간다", () => {
    expect(toggleDockRatio(DOCK_RATIO_LOW, 1000)).toBe(DOCK_RATIO_HIGH);
    expect(toggleDockRatio(DOCK_RATIO_HIGH, 1000)).toBe(DOCK_RATIO_LOW);
    // 끌어서 어중간한 높이에서도 한쪽에 선다.
    expect(toggleDockRatio(0.5, 1000)).toBe(DOCK_RATIO_HIGH);
    expect(toggleDockRatio(0.6, 1000)).toBe(DOCK_RATIO_LOW);
  });

  it("도크 바닥과 위 화면 바닥으로 자른다", () => {
    expect(clampDockRatio(0.01, 1000)).toBeCloseTo(DOCK_MIN_PX / 1000);
    expect(clampDockRatio(0.99, 1000)).toBeCloseTo(1 - DOCK_ROUTE_FLOOR_PX / 1000);
    expect(clampDockRatio(0.5, 1000)).toBe(0.5);
  });

  it("판이 두 바닥의 합보다 낮으면 도크 바닥이 이긴다", () => {
    expect(clampDockRatio(0.2, 250)).toBeCloseTo(DOCK_MIN_PX / 250);
  });

  it("끌기는 판 바닥에서 포인터까지의 몫이다", () => {
    expect(dockRatioFromPointer(600, 100, 1000)).toBeCloseTo(0.5);
    expect(dockRatioFromPointer(1090, 100, 1000)).toBeCloseTo(DOCK_MIN_PX / 1000);
  });

  it("저장 형식은 왕복하고, 깨진 값은 null", () => {
    expect(parseDockPrefs(serializeDockPrefs({ v: 1, ratio: 0.55 }))).toEqual({ v: 1, ratio: 0.55 });
    for (const raw of [null, "", "{", "[]", '{"v":2,"ratio":0.5}', '{"v":1,"ratio":1}', '{"v":1,"ratio":"0.5"}']) {
      expect(parseDockPrefs(raw)).toBeNull();
    }
  });
});
