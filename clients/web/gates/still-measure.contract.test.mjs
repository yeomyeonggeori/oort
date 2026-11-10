// 흔들림 장면표의 재는 스크립트(`still-measure.mjs`) 계약 (#5641). 브라우저 없이 지어낸 위치 열로 숫자 넷이 옳게 세어지는지,
// 그리고 틀린 환경 값으로 게이트가 「0번 돌고 통과」하지 못하는지(#5644 검수 M1)를 잠근다.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judgeCell, listEnv, motionOf, nothingRan, positiveIntEnv, stillNumbers } from "./still-measure.mjs";

const gatesDir = dirname(fileURLToPath(import.meta.url));

describe("숫자 넷", () => {
  it("한 방향으로 한 번 움직이면 되돌아옴 0, 예상 이동과 같으면 이유 없는 이동 0", () => {
    const numbers = stillNumbers({ series: [603.12, 603.12, 558.75, 558.75, 558.75], expected: 44.37 });
    expect(numbers.reversals).toBe(0);
    expect(numbers.unexplainedPx).toBe(0);
    expect(numbers.motion.steps).toBe(1);
  });

  it("범위 안에서 갔다가 돌아오면 센다 — 옛 문턱(+10px)이 못 보던 것", () => {
    // 44.37px 올라간 뒤 5px 내려갔다가 다시 올라감: 움직인 폭은 44.37 그대로라 옛 판정은 통과였다.
    const series = [603.12, 558.75, 563.75, 563.75, 563.75, 558.75, 558.75];
    const numbers = stillNumbers({ series, expected: 44.37 });
    expect(numbers.motion.range).toBe(44.37);
    expect(numbers.reversals).toBe(2);
    expect(judgeCell(numbers, { kind: "expected", minSamples: 3 }).verdict).toBe("FAIL");
  });

  it("1px 아래의 떨림은 되돌아옴이 아니다(정수 scrollTop · 소수 가장자리)", () => {
    const numbers = stillNumbers({ series: [660.36, 659.61, 660.36, 659.61, 660.36], gaps: [0, 0, 0, 0, 0], pills: [false, false, false, false, false] });
    expect(numbers.reversals).toBe(0);
    expect(numbers.unexplainedPx).toBe(0.75);
    expect(judgeCell(numbers, { kind: "bottom", minSamples: 3 }).verdict).toBe("PASS");
  });

  it("바닥 거리 · 저절로 선 필을 센다(위를 읽는 중 이미 선 필은 세지 않는다)", () => {
    const bottom = stillNumbers({ series: [700, 700, 700], gaps: [0, 165, 0], pills: [false, true, false], pillMounts: 1 });
    expect(bottom.maxGapPx).toBe(165);
    expect(bottom.pillShows).toBe(1);
    expect(judgeCell(bottom, { kind: "bottom", minSamples: 3 }).reasons.join(" ")).toMatch(/바닥 거리 165px.*필 1번/);
    const reading = stillNumbers({ series: [300, 300, 300], pills: [true, true, true], pillAtStart: true, pillMounts: 0 });
    expect(reading.pillShows).toBe(0);
  });

  it("지켜본 줄이 없으면 0px 가 아니라 「장면 못 만듦」", () => {
    const numbers = stillNumbers({ series: [null, null, null] });
    expect(numbers.unexplainedPx).toBeNull();
    expect(judgeCell(numbers, { kind: "reading" }).verdict).toBe("장면 못 만듦");
    expect(motionOf([])).toBeNull();
  });
});

describe("환경 값 — 0번 돌고 통과할 수 없다 (#5644 검수 M1)", () => {
  it("되풀이 횟수는 1 이상의 정수만 받는다", () => {
    for (const bad of ["abc", "0", "1.5", "-1", " ", "2x"]) {
      expect(() => positiveIntEnv("X", 1, { X: bad }), bad).toThrow(/1 이상의 정수/);
    }
    expect(positiveIntEnv("X", 1, {})).toBe(1);
    expect(positiveIntEnv("X", 1, { X: "3" })).toBe(3);
  });

  it("목록 값의 오타 · 빈 목록은 던진다", () => {
    expect(() => listEnv("S", ["a", "b"], ["a"], { S: "a,typo" })).toThrow(/모르는 값/);
    expect(() => listEnv("S", ["a", "b"], ["a"], { S: " , " })).toThrow(/빈 목록/);
    expect(listEnv("S", ["a", "b"], ["a"], {})).toEqual(["a"]);
  });

  it("잰 장면이 0개면 실패 문장을 낸다", () => {
    expect(nothingRan(0, "g")).toMatch(/0번 돌고 통과할 수 없다/);
    expect(nothingRan(2, "g")).toBeNull();
  });

  it("게이트에 숫자가 아닌 되풀이 값을 주면 시작 전에 실패하고 PASS 를 내지 않는다", () => {
    const cases = [
      ["gate-expression-jitter.mjs", { EXPRESSION_JITTER_REPEAT: "abc", EXPRESSION_JITTER_PORT: "1" }],
      ["gate-timeline-still.mjs", { TIMELINE_STILL_REPEAT: "abc", TIMELINE_STILL_PORT: "1" }],
      ["gate-send-follow.mjs", { SEND_FOLLOW_SKEW_SCENES: "boundry", SEND_FOLLOW_PORT: "1" }],
    ];
    for (const [script, env] of cases) {
      const run = spawnSync(process.execPath, [resolve(gatesDir, script)], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
      expect(run.status, script).not.toBe(0);
      expect(run.stdout, script).not.toMatch(/PASS/);
      expect(run.stderr, script).toMatch(/1 이상의 정수|모르는 값/);
    }
  }, 120_000);
});
