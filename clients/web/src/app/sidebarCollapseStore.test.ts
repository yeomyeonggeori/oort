// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_COLLAPSED_KEY,
  getSidebarCollapsed,
  resetSidebarCollapsedForTest,
  setSidebarCollapsed,
} from "./sidebarCollapseStore";

// #3280: 목록 열 접힘은 기기별로 기억한다(#1864의 비저장을 이 패널에서 대체). 저장소가 막혀도
// 앱은 펼침 기본으로 동작해야 한다.

beforeEach(() => {
  window.localStorage.clear();
  resetSidebarCollapsedForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sidebarCollapseStore", () => {
  it("접으면 저장하고, 펴면 키를 지운다", () => {
    expect(getSidebarCollapsed()).toBe(false);
    setSidebarCollapsed(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
    setSidebarCollapsed(false);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBeNull();
  });

  it("저장된 접힘을 다음 실행(모듈 재적재)에서 다시 읽는다", () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    resetSidebarCollapsedForTest();
    expect(getSidebarCollapsed()).toBe(true);
  });

  it("저장소 접근이 던져도(사생활 보호 창) 던지지 않고 메모리에서 동작한다", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setSidebarCollapsed(true)).not.toThrow();
    expect(getSidebarCollapsed()).toBe(true);
    expect(() => resetSidebarCollapsedForTest()).not.toThrow();
    expect(getSidebarCollapsed()).toBe(false); // 읽지 못하면 펼침 기본
  });
});
