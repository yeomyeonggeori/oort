import { describe, expect, it, vi } from "vitest";
import {
  hasLocalCardHost,
  openLocalCardIn,
  registerLocalCardHost,
} from "./localCards";

describe("로컬 카드 자리 (#2943)", () => {
  it("자리가 없으면 false — 명령이 스스로 폴백한다", () => {
    expect(openLocalCardIn("ch-none", "ai.connect", {})).toBe(false);
    expect(openLocalCardIn(null, "ai.connect", {})).toBe(false);
    expect(hasLocalCardHost(null)).toBe(false);
  });

  it("등록한 채널에서만 열리고 인자가 그대로 간다", () => {
    const host = vi.fn(() => true);
    const release = registerLocalCardHost("CH-1", host);
    expect(hasLocalCardHost("ch-1")).toBe(true);
    expect(openLocalCardIn("ch-1", "ai.connect", { line: "team" })).toBe(true);
    expect(host).toHaveBeenCalledWith("ai.connect", { line: "team" });
    expect(openLocalCardIn("ch-2", "ai.connect", {})).toBe(false);
    release();
    expect(openLocalCardIn("ch-1", "ai.connect", {})).toBe(false);
  });

  it("옛 화면의 해제가 새 화면의 자리를 지우지 않는다", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const releaseFirst = registerLocalCardHost("ch-3", first);
    const releaseSecond = registerLocalCardHost("ch-3", second);
    releaseFirst();
    expect(openLocalCardIn("ch-3", "ai.connect", {})).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    releaseSecond();
    expect(hasLocalCardHost("ch-3")).toBe(false);
  });
});
