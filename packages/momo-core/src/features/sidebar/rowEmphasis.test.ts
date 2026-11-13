import { describe, expect, it } from "vitest";
import {
  CHIP_COUNT_CAP,
  CHIP_TONE,
  readPhaseMayDim,
  rowEmphasis,
  type RowEmphasisInput,
} from "./rowEmphasis";

// 웹·데스크탑(#5775)과 폰(#4953)이 같이 읽는 한 함수. 폰의 줄 단위 시험은 `clients/mobile/__tests__/sidebarRowEmphasis.test.ts`,
// 웹의 줄 배선은 `Sidebar.dm.test.tsx` 가 잰다. 여기서는 규칙 자체를 잰다.

const READ: RowEmphasisInput = {
  unreadCount: 0,
  mentionCount: 0,
  muted: false,
  tracksRead: true,
  mayDim: true,
  selected: false,
};

describe("rowEmphasis — 읽은 줄·안 읽은 줄·열린 줄·음소거 줄", () => {
  it("읽은 줄은 연하다", () => {
    expect(rowEmphasis(READ)).toEqual({ dim: true, bold: false, chip: null });
  });

  it("안 읽은 줄은 또렷하고 굵고 칩이 있다", () => {
    expect(rowEmphasis({ ...READ, unreadCount: 3 })).toEqual({
      dim: false,
      bold: true,
      chip: { tone: CHIP_TONE.count, glyphs: "3" },
    });
  });

  it("열린 줄은 읽었어도 음소거여도 연하지 않다", () => {
    expect(rowEmphasis({ ...READ, selected: true }).dim).toBe(false);
    expect(rowEmphasis({ ...READ, selected: true, muted: true }).dim).toBe(false);
  });

  it("음소거 줄은 새 글이 있어도 연하고 굵지 않다", () => {
    expect(rowEmphasis({ ...READ, muted: true, unreadCount: 4 })).toEqual({
      dim: true,
      bold: false,
      chip: { tone: CHIP_TONE.muted, glyphs: "4" },
    });
  });

  it("읽음 정보를 못 받았으면(mayDim 거짓) 새 글 없는 줄도 연하지 않다 — 음소거는 사실이라 그대로 연하다", () => {
    expect(rowEmphasis({ ...READ, mayDim: false }).dim).toBe(false);
    expect(rowEmphasis({ ...READ, mayDim: false, muted: true }).dim).toBe(true);
  });

  it("읽음을 말하지 않는 줄(갈 곳)은 연하지도 굵지도 않다", () => {
    expect(rowEmphasis({ ...READ, tracksRead: false, unreadCount: 9 })).toEqual({
      dim: false,
      bold: false,
      chip: null,
    });
  });

  it("칩 숫자는 99 에서 멈춘다", () => {
    expect(CHIP_COUNT_CAP).toBe(99);
    expect(rowEmphasis({ ...READ, unreadCount: 100 }).chip?.glyphs).toBe("99+");
  });
});

describe("readPhaseMayDim — 읽음 투영의 국면", () => {
  it("실패(error)만 연하게 칠하지 않는다. 오는 중과 모름(undefined)은 조용한 쪽이다", () => {
    expect([
      readPhaseMayDim("error"),
      readPhaseMayDim("loading"),
      readPhaseMayDim("ready"),
      readPhaseMayDim(undefined),
    ]).toEqual([false, true, true, true]);
  });
});
