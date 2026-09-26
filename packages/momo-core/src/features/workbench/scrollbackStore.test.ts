import { describe, expect, it } from "vitest";
import {
  SCROLLBACK_LINE_STEPS,
  fitSerialized,
  parseScrollback,
  scrollbackEntry,
  serializeScrollback,
  staleScrollbackEntries,
} from "./scrollbackStore";

describe("스크롤백 저장 형식", () => {
  it("상한 안에 드는 가장 긴 직렬화를 고른다", () => {
    const asked: number[] = [];
    const out = fitSerialized((lines) => {
      asked.push(lines);
      return "x".repeat(lines * 10 + 5);
    }, 3000);
    expect(out).toBe("x".repeat(2005));
    expect(asked).toEqual([2000, 1000, 500, 200]);
  });

  it("화면만으로도 넘치면 저장하지 않는다(잘린 이스케이프를 남기지 않는다)", () => {
    expect(fitSerialized(() => "y".repeat(100), 10)).toBeNull();
    expect(SCROLLBACK_LINE_STEPS.at(-1)).toBe(0);
  });

  it("왕복하고, 모양이 틀리면 null", () => {
    const saved = { v: 1 as const, data: "\u001b[31mred\u001b[0m\r\n$ ", cols: 80, rows: 24, savedAt: 1 };
    expect(parseScrollback(serializeScrollback(saved))).toEqual(saved);
    for (const raw of [
      null,
      "nope",
      JSON.stringify({ ...saved, v: 2 }),
      JSON.stringify({ ...saved, cols: 0 }),
      JSON.stringify({ ...saved, rows: 501 }),
      JSON.stringify({ ...saved, data: 5 }),
    ]) {
      expect(parseScrollback(raw)).toBeNull();
    }
  });

  it("지금 배치에 없는 칸의 항목만 정리 대상이다", () => {
    const entries = [
      scrollbackEntry("dock", "p1"),
      scrollbackEntry("dock", "p2"),
      scrollbackEntry("dock", "p7"),
      scrollbackEntry("other", "p9"),
      "momo.web.theme",
    ];
    expect(staleScrollbackEntries(entries, "dock", ["p1", "p2"])).toEqual([scrollbackEntry("dock", "p7")]);
  });
});
