import { describe, expect, it } from "vitest";
import { placeRowClock, ROW_CLOCK_GAP_PX, type RowClockRect } from "./rowClockPlacement";

// 이어지는 행의 시각이 줄 오른쪽 어디에 서는가(#6026)의 규칙 표. 맨 아래 줄부터, 오른끝에 시각 폭 + 틈만큼 아무것도 없는 첫 줄의
// 가운데 높이에 선다. 막는 것은 글줄 · 칠해진 상자 · 호버 막대이고, 그런 줄이 없으면 null(= 거터)이다. DOM 재기는 캡처 · 게이트가 진다.

const BODY_RIGHT = 600;
const CLOCK = { width: 40, height: 14 };
const line = (top: number, right: number, left = 100): RowClockRect => ({ left, right, top, bottom: top + 20 });

describe("placeRowClock", () => {
  const rows: {
    name: string;
    lines: RowClockRect[];
    boxes?: RowClockRect[];
    expected: { left: number; top: number } | null;
  }[] = [
    { name: "짧은 한 줄: 그 줄 오른끝, 줄 가운데 높이", lines: [line(0, 300)], expected: { left: 560, top: 3 } },
    {
      name: "여러 줄: 맨 아래 줄(짧은 끝줄)",
      lines: [line(0, 600), line(20, 600), line(40, 250)],
      expected: { left: 560, top: 43 },
    },
    {
      name: "끝줄이 꽉 차면 그 위의 빈 줄로 올라간다",
      lines: [line(0, 300), line(20, 600)],
      expected: { left: 560, top: 3 },
    },
    {
      name: "한 줄이 여러 조각이어도 한 띠로 본다(조각 하나가 오른끝에 닿으면 막힌다)",
      lines: [line(0, 300), line(0, 590, 320)],
      expected: null,
    },
    {
      name: "틈보다 가까이 닿는 글은 막는다",
      lines: [line(0, BODY_RIGHT - CLOCK.width - ROW_CLOCK_GAP_PX + 1)],
      expected: null,
    },
    {
      name: "틈만큼 떨어진 글은 막지 않는다",
      lines: [line(0, BODY_RIGHT - CLOCK.width - ROW_CLOCK_GAP_PX)],
      expected: { left: 560, top: 3 },
    },
    {
      name: "행 안으로 밀려 앉은 호버 막대가 끝줄 오른쪽을 덮으면 그 위 줄",
      lines: [line(0, 200), line(20, 200)],
      boxes: [{ left: 380, right: 600, top: 22, bottom: 64 }],
      expected: { left: 560, top: 3 },
    },
    {
      name: "코드 · 카드처럼 폭을 다 쓰는 칠해진 상자 안의 줄은 막히고 그 위 글줄",
      lines: [line(0, 200), line(30, 300, 110)],
      boxes: [{ left: 100, right: 600, top: 26, bottom: 56 }],
      expected: { left: 560, top: 3 },
    },
    { name: "모든 줄이 꽉 차면 null(거터)", lines: [line(0, 600), line(20, 600)], expected: null },
    { name: "글줄이 없으면 null(거터)", lines: [], expected: null },
  ];
  it.each(rows)("$name", ({ lines, boxes, expected }) => {
    expect(placeRowClock({ body: { right: BODY_RIGHT }, clock: CLOCK, lines, boxes: boxes ?? [] })).toEqual(expected);
  });
});
