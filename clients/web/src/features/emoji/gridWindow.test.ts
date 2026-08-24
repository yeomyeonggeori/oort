import { describe, expect, it } from "vitest";
import {
  EMOJI_GRID_COLS,
  EMOJI_GRID_RENDER_LIMIT,
  emojiGridPadRows,
  emojiGridWindow,
} from "./gridWindow";

describe("emojiGridWindow", () => {
  it("renders the whole list when it fits in the cap", () => {
    expect(emojiGridWindow(32, 0)).toEqual({ start: 0, end: 32 });
  });

  it("caps mounted cells and snaps to a column boundary", () => {
    const { start, end } = emojiGridWindow(1914, 0);
    expect(end - start).toBeLessThanOrEqual(EMOJI_GRID_RENDER_LIMIT);
    expect(start % EMOJI_GRID_COLS).toBe(0);
    expect(start).toBe(0);
  });

  it("keeps the keyboard cursor inside the window", () => {
    const center = 400;
    const { start, end } = emojiGridWindow(1914, center);
    expect(center).toBeGreaterThanOrEqual(start);
    expect(center).toBeLessThan(end);
    expect(end - start).toBeLessThanOrEqual(EMOJI_GRID_RENDER_LIMIT);
  });

  it("counts pad rows for unmounted items", () => {
    expect(emojiGridPadRows(0)).toBe(0);
    expect(emojiGridPadRows(8)).toBe(1);
    expect(emojiGridPadRows(9)).toBe(2);
  });
});
