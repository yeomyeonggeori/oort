import { describe, expect, it } from "vitest";
import { emptyExpressionUsage, FRECENT_HALF_LIFE_DAYS, frecentExpressions, recordExpressionUse, type ExpressionUsage } from "./usage";

// 「자주·최근」 점수 (#5503, owner 2026-11-07): 횟수 x 0.5^(마지막으로 쓴 뒤 지난 날 / 7). 같은 점수는 최근에 쓴 것이 먼저다. 순수 함수라 기준 시각 `nowMs` 를 받는다.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 12);

/** `[id, 횟수, 며칠 전에 마지막으로]` 로 쓴 기록. 마지막 시각만 남는 기록이라 횟수는 모두 그 시각에 쓴 것으로 센다. */
function used(rows: ReadonlyArray<readonly [string, number, number]>): ExpressionUsage {
  let usage = emptyExpressionUsage("w", "m");
  for (const [id, times, daysAgo] of rows) for (let i = 0; i < times; i += 1) usage = recordExpressionUse(usage, id, Math.round(NOW - daysAgo * DAY));
  return usage;
}
const order = (usage: ExpressionUsage, available?: ReadonlySet<string>) => frecentExpressions(usage, available, NOW).map((entry) => entry.id);

describe("frecentExpressions — 횟수와 최근을 함께 본 차례", () => {
  it("반감기는 7일이다", () => {
    expect(FRECENT_HALF_LIFE_DAYS).toBe(7);
  });

  it("횟수가 같으면 최근에 쓴 것이 위이고, 시각이 같으면 id 순이다", () => {
    expect(order(used([["old", 1, 9], ["new", 1, 1], ["mid", 1, 4]]))).toEqual(["new", "mid", "old"]);
    expect(order(used([["b", 2, 0], ["a", 2, 0]]))).toEqual(["a", "b"]);
  });

  it("많이 쓴 것과 최근 것의 맞바꿈: 어제 1번이 한 달 전 10번보다 위이고, 사흘 전 10번은 어제 1번보다 위다", () => {
    // 1 x 0.5^(1/7) = 0.91 > 10 x 0.5^(30/7) = 0.51
    expect(order(used([["monthAgo10", 10, 30], ["yesterday1", 1, 1]]))).toEqual(["yesterday1", "monthAgo10"]);
    // 10 x 0.5^(3/7) = 7.4 > 0.91
    expect(order(used([["yesterday1", 1, 1], ["threeDays10", 10, 3]]))).toEqual(["threeDays10", "yesterday1"]);
    // 아주 많이 쓴 것은 한 달 전이어도 위다(횟수도 점수에 든다): 20 x 0.5^(30/7) = 1.03 > 0.91
    expect(order(used([["yesterday1", 1, 1], ["monthAgo20", 20, 30]]))).toEqual(["monthAgo20", "yesterday1"]);
  });

  it("반감기가 지나면 점수가 절반이다: 7일 전 2번은 방금 1번과 점수가 같고, 같은 점수는 최근에 쓴 것이 앞이다", () => {
    // a(7일 전 2번)가 id 순으로는 앞이지만 점수가 같을 때는 마지막으로 쓴 시각이 우선이다 -> b(방금)가 앞.
    expect(order(used([["a", 2, 7], ["b", 1, 0]]))).toEqual(["b", "a"]);
    // 하루만 덜 지났어도 a 가 앞이다(점수 > 1).
    expect(order(used([["a", 2, 6], ["b", 1, 0]]))).toEqual(["a", "b"]);
  });

  it("후보(`availableIds`) 밖의 기록은 서지 않고, 받은 사용 기록은 바뀌지 않는다", () => {
    const usage = used([["keep", 1, 2], ["gone", 9, 0], ["also", 2, 3]]);
    const before = JSON.stringify(usage);
    expect(order(usage, new Set(["keep", "also"]))).toEqual(["also", "keep"]); // 2 x 0.74 = 1.49 > 0.82 (gone 은 후보 밖)
    expect(order(usage, new Set())).toEqual([]);
    expect(JSON.stringify(usage)).toBe(before);
  });

  it("아주 오래된 기록도 횟수의 차이가 0으로 뭉개지지 않는다", () => {
    // 1970년 근처(20000일 전): 점수를 그대로 곱하면 둘 다 0 이 되어 id 순이 된다.
    let usage = recordExpressionUse(emptyExpressionUsage("w", "m"), "a_once", 1000);
    for (let i = 0; i < 5; i += 1) usage = recordExpressionUse(usage, "b_often", 1000);
    expect(order(usage)).toEqual(["b_often", "a_once"]);
  });

  it("시계가 어긋나 미래 시각이 적힌 기록은 방금 쓴 것으로 센다 - 미래일수록 위가 되지 않는다", () => {
    const usage = used([["future1", 1, -30], ["now2", 2, 0]]);
    expect(order(usage)).toEqual(["now2", "future1"]);
  });
});
