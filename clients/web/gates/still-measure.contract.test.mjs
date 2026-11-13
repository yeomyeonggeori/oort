// 흔들림 장면표의 재는 스크립트(`still-measure.mjs`) 계약 (#5641). 브라우저 없이 지어낸 위치 열로 숫자 넷이 옳게 세어지는지,
// 그리고 틀린 환경 값으로 게이트가 「0번 돌고 통과」하지 못하는지(#5644 검수 M1)를 잠근다.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { describe, expect, it } from "vitest";
import {
  entrySettle,
  entryWindow,
  finalVerdict,
  frameGaps,
  installEntryRecorder,
  judgeCell,
  listEnv,
  MAX_ENTRY_HIDDEN_FRAMES,
  motionOf,
  nothingRan,
  numbersFromRecord,
  positiveIntEnv,
  rapidSettleWithin,
  readEntryRecord,
  SEND_KNOWN,
  shortfallWithin,
  staleKnown,
  startStillRecorder,
  stillNumbers,
  stopStillRecorder,
  TIMELINE_KNOWN_FAILURES,
  withinKnown,
} from "./still-measure.mjs";

const gatesDir = dirname(fileURLToPath(import.meta.url));
/** 알려진 실패 목록의 모양(키 · 이슈 · 상한). 목록을 바꾸면 여기도 바꾼다 — 바꾼 것이 시험 차이로 드러난다. */
/** 알려진 실패 목록의 모양(키 · 이슈 · 상한: px · 되돌아옴 · 바닥 거리 · 자리 잡기 전 프레임 · 사라진 프레임 · 필 · notBuilt).
 * 목록을 바꾸면 여기도 바꾼다 — 줄을 더하거나 상한을 넓힌 것이 시험 차이로 드러난다. */
const KNOWN_SHAPE = [
  ["entry|chromium|1280", "#5641", null, null, null, 2, null, null, null],
  ["entry|chromium|900", "#5641", null, null, null, 2, null, null, null],
  ["entry|chromium|390", "#5641", null, null, null, 2, null, null, null],
  ["entry|webkit|1280", "#5641", null, null, null, 3, null, null, null],
  ["entry|webkit|900", "#5641", null, null, null, 3, null, null, null],
  ["entry|webkit|390", "#5641", null, null, null, 3, null, null, null],
  ["entry-card|chromium|1280", "#5641", 4.75, null, null, 2, null, null, null],
  ["entry-card|chromium|900", "#5641", 4.75, null, null, 2, null, null, null],
  ["entry-card|chromium|390", "#5641", null, null, null, 2, null, null, null],
  ["entry-card|webkit|1280", "#5641", 4.38, null, null, 3, null, null, null],
  ["entry-card|webkit|900", "#5641", 4.38, null, null, 3, null, null, null],
  ["entry-card|webkit|390", "#5641", null, null, null, 3, null, null, null],
  ["older|chromium|1280", "#5641", 5.25, null, null, null, null, null, null],
  ["older|chromium|900", "#5641", 5.25, null, null, null, null, null, null],
  ["older|chromium|390", "#5641", 5.25, null, null, null, null, null, null],
  ["older|webkit|1280", "#5662", 4.69, null, null, null, null, null, "notBuilt"],
  ["older|webkit|900", "#5662", 4.69, null, null, null, null, null, "notBuilt"],
  ["reaction-bottom-added|webkit|1280", "#5641", 1.63, null, null, null, null, null, null],
  ["reaction-bottom-added|webkit|900", "#5641", 1.63, null, null, null, null, null, null],
  ["reaction-bottom-removed|webkit|1280", "#5641", null, null, 2, null, null, null, null],
  ["reaction-bottom-removed|webkit|900", "#5641", null, null, 2, null, null, null, null],
];

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

  it("보던 줄이 화면 밖으로 밀려 사라지면 남은 프레임이 0px 여도 실패다", () => {
    // 앞 붙이기 보정을 끈 번들(실측): 보던 줄이 2,274px 아래로 밀려 붙임 범위 밖 — 사라진 프레임을 빼면 움직임 0 이었다.
    const numbers = stillNumbers({ series: [110, 110, 110, null, null, null] });
    expect(numbers.unexplainedPx).toBe(0);
    expect(numbers.vanishedFrames).toBe(3);
    expect(judgeCell(numbers, { kind: "reading", minSamples: 3 }).verdict).toBe("FAIL");
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

// ---------------------------------------------------------------------------------------------- #5641 검수 r1 수리

describe("되돌아감의 크기 · send-follow 알려진 실패의 테두리 (검수 r1 M3)", () => {
  it("되돌아감의 가장 큰 다리를 잰다 — 범위 안에서 갔다가 와도 0 이 아니다", () => {
    expect(motionOf([603.12, 558.75, 563.75, 563.75, 558.75]).maxBackPx).toBe(5);
    expect(motionOf([700, 700, 700]).maxBackPx).toBe(0);
  });

  it("연달아 장면: 실측(2회 · 7.4px)은 테두리 안, 40px × 4회 · 3회 · 12px 는 밖", () => {
    // 위 줄(창 좌표): 첫 글이 붙어 64.4px 올라감 → 다음 프레임 7.4px 내려앉음 → 둘째 글로 다시 올라감(실측 모양).
    const measured = motionOf([600, 535.6, 543, 543, 471.2, 471.2]);
    expect(measured.reversals).toBe(2);
    expect(measured.maxBackPx).toBe(7.4);
    expect(rapidSettleWithin(measured)).toBe(true);
    // 사보타주(검수 r1 g.log): 되돌아옴 40px 를 네 번.
    const bounced = motionOf([600, 535.6, 575.6, 535.6, 575.6, 535.6, 471.2]);
    expect(bounced.reversals).toBe(4);
    expect(rapidSettleWithin(bounced)).toBe(false);
    expect(rapidSettleWithin({ reversals: 3, maxBackPx: 5 })).toBe(false);
    expect(rapidSettleWithin({ reversals: 2, maxBackPx: 12 })).toBe(false);
    expect(rapidSettleWithin({ reversals: null, maxBackPx: null })).toBe(false);
  });

  it("바닥 거리가 없으면(null) 알려진 모자람이 아니라 실패다", () => {
    expect(shortfallWithin(8)).toBe(true);
    expect(shortfallWithin(null)).toBe(false);
    expect(shortfallWithin(SEND_KNOWN.shortfall.maxGapPx + 0.5)).toBe(false);
  });
});

describe("대화 진입의 창 (검수 r1 H1)", () => {
  // 실측 모양(Chromium 1280): 이 대화의 줄이 처음 붙은 프레임은 scrollTop 0 · 가장 새 줄 없음, 다음 프레임도 가장 새 줄 없음, 그 뒤 자리 잡음.
  const raw = [
    { n: 1, t: 1000, match: false, top: 0, gap: 0, pill: false, watch: { last: null } }, // 먼저 열린 빈 채널
    { n: 2, t: 1016, match: true, top: 0, gap: 2038, pill: false, watch: { last: null } },
    { n: 3, t: 1041, match: true, top: 2664, gap: 6, pill: false, watch: { last: null } },
    ...Array.from({ length: 20 }, (_, i) => ({ n: 4 + i, t: 1058 + i * 16, match: true, top: 2664, gap: 4, pill: false, watch: { last: 664.36 } })),
    { n: 30, t: 1016 + 2_100, match: true, top: 2664, gap: 4, pill: false, watch: { last: 600 } }, // 창 밖
  ];

  it("이 대화의 줄이 처음 붙은 프레임부터 재고, 가장 새 줄이 없는 첫 프레임을 버리지 않는다", () => {
    const picked = entryWindow(raw, { windowMs: 2_000 });
    expect(picked.before).toBe(1);
    expect(picked.frames[0].t).toBe(0);
    expect(picked.frames[0].top).toBe(0);
    expect(picked.frames.filter((frame) => frame.watch.last === null)).toHaveLength(2);
    // 창 밖(2.1초)의 600px 은 들어오지 않는다.
    expect(numbersFromRecord({ frames: picked.frames, pillMounts: 0, pillAtStart: false }, { watch: "last" }).unexplainedPx).toBe(0);
  });

  it("자리 잡기 전 프레임(머리)을 가른다 — 엉뚱한 곳에 보였다 사라지는 프레임도 머리다(WebKit 판 A)", () => {
    const at = (last, top = 2664, gap = 4) => ({ t: 0, top, gap, watch: { last } });
    const chromiumShape = entrySettle([at(null, 0, 2038), at(null, 2664, 6), at(664.36), at(664.36), at(664.36), at(660.36)]);
    expect(chromiumShape.head).toHaveLength(2);
    expect(chromiumShape.summary).toMatch(/가장 새 줄 없음 2프레임 · scrollTop 0→2664 · 바닥 거리 최대 2038px/);
    const webkitA = entrySettle([at(null, 0, 2038), at(1475, 2174, 815), at(null, 2982, 0), at(664), at(664), at(664)]);
    expect(webkitA.head).toHaveLength(3);
    expect(webkitA.summary).toMatch(/제자리에서 811px 떨어져 보임 1프레임/);
    expect(entrySettle([at(664), at(664), at(664)]).head).toHaveLength(0);
    expect(entrySettle([at(null), at(664), at(700)]).body).toHaveLength(0);
  });

  it("그리기 직전 표본을 놓친 프레임을 센다 — 처음 세 프레임 사이에서 놓치면 통과로 치지 않는다", () => {
    const frames = entryWindow(raw, { windowMs: 2_000 }).frames;
    expect(frameGaps(frames).reason).toBeNull();
    const holed = frames.filter((frame) => frame.n !== 3);
    expect(frameGaps(holed).missedAtStart).toBe(1);
    expect(frameGaps(holed).reason).toMatch(/놓쳤다/);
  });
});

describe("대화 진입 — 그려진 프레임만 · 가려 둔 시간 · 바닥 거리 (#5678 · #5679)", () => {
  // 앱이 자리 잡기 전의 목록을 가려 두는 모양(#5678): 줄이 붙은 첫 세 프레임은 가려진 채(`visible: false`) 맨 위 · 가장 새 줄 없음이고,
  // 처음 보인 프레임에는 이미 바닥에 서 있다.
  const frame = (n, { visible = true, last = 664.36, top = 2671, gap = 0, match = true } = {}) => ({ n, t: 1000 + n * 16, match, visible, top, gap, pill: false, watch: { last } });
  const hiddenThenPlaced = [
    frame(1, { match: false, last: null, top: 0 }),
    frame(2, { visible: false, last: null, top: 0, gap: 2038 }),
    frame(3, { visible: false, last: null }),
    frame(4, { visible: false, last: 1475, top: 2174, gap: 815 }),
    ...Array.from({ length: 20 }, (_, i) => frame(5 + i)),
  ];

  it("가려진 프레임은 창에 넣지 않고 따로 센다 — 처음 보인 프레임부터 재면 자리 잡기 전 프레임이 0", () => {
    const picked = entryWindow(hiddenThenPlaced, { windowMs: 2_000 });
    expect(picked.hidden).toEqual({ frames: 3, ms: 48, never: false });
    expect(picked.frames[0].n).toBe(5);
    expect(entrySettle(picked.frames).head).toHaveLength(0);
  });

  it("가리지 않으면(옛 판 · 앱이 가리지 않음) 같은 프레임이 그대로 머리로 잡힌다 — 「보인」 판정이 머리를 지우는 유일한 길이다", () => {
    const unhidden = hiddenThenPlaced.map((one) => ({ ...one, visible: true }));
    const picked = entryWindow(unhidden, { windowMs: 2_000 });
    expect(picked.hidden.frames).toBe(0);
    expect(entrySettle(picked.frames).head).toHaveLength(3);
    // `visible` 을 적지 않은 기록도 보인 것으로 친다.
    const legacy = hiddenThenPlaced.map((one) => {
      const rest = { ...one };
      delete rest.visible;
      return rest;
    });
    expect(entrySettle(entryWindow(legacy, { windowMs: 2_000 }).frames).head).toHaveLength(3);
  });

  it("한 번 보인 뒤 다시 가려지면 그 프레임은 줄이 없는 프레임이다(사라짐 → 실패)", () => {
    const flicker = [...hiddenThenPlaced];
    flicker[10] = { ...flicker[10], visible: false };
    const picked = entryWindow(flicker, { windowMs: 2_000 });
    const numbers = numbersFromRecord({ frames: picked.frames, pillMounts: 0, pillAtStart: false }, { watch: "last" });
    expect(numbers.vanishedFrames).toBe(1);
    expect(judgeCell(numbers, { kind: "entry" }).verdict).toBe("FAIL");
  });

  it("끝내 보이지 않으면 창이 비고 `never` 다 · 가려 둔 프레임이 상한을 넘으면 알려진 실패 줄도 덮지 못한다", () => {
    const never = hiddenThenPlaced.map((one) => ({ ...one, visible: false }));
    const picked = entryWindow(never, { windowMs: 2_000 });
    expect(picked.frames).toHaveLength(0);
    expect(picked.hidden.never).toBe(true);
    expect(picked.hidden.frames).toBe(23);
    const known = { key: "entry|webkit|1280", issue: "#1", maxUnsettledFrames: 3 };
    const fine = { reversals: 0, unexplainedPx: 0, maxGapPx: 0, pillShows: 0, vanishedFrames: 0 };
    expect(withinKnown(known, fine, { kind: "entry", hidden: MAX_ENTRY_HIDDEN_FRAMES })).toBe(true);
    expect(withinKnown(known, fine, { kind: "entry", hidden: MAX_ENTRY_HIDDEN_FRAMES + 1 })).toBe(false);
  });

  it("진입의 바닥 거리도 판정한다 — 자리 잡은 뒤 바닥에서 4px 모자라면 실패이고 알려진 실패 줄이 덮지 않는다(#5679)", () => {
    const shortBy = (gap) => entryWindow(hiddenThenPlaced.map((one) => (one.visible ? { ...one, gap } : one)), { windowMs: 2_000 }).frames;
    const numbers = (gap) => numbersFromRecord({ frames: shortBy(gap), pillMounts: 0, pillAtStart: false }, { watch: "last" });
    expect(judgeCell(numbers(0), { kind: "entry" }).verdict).toBe("PASS");
    expect(judgeCell(numbers(1), { kind: "entry" }).verdict).toBe("PASS");
    expect(judgeCell(numbers(4), { kind: "entry" }).reasons).toContain("바닥 거리 4px(> 1)");
    expect(withinKnown({ key: "entry-card|chromium|1280", issue: "#1", maxUnsettledFrames: 2, maxUnexplainedPx: 4.75 }, numbers(4), { kind: "entry" })).toBe(false);
  });
});

describe("알려진 실패 목록 (검수 r1 M2 · 브리프 4)", () => {
  it("줄마다 정확한 칸 키(별표 없음) · 이슈 번호 · 숫자 상한이 있다", () => {
    expect(TIMELINE_KNOWN_FAILURES.length).toBeGreaterThan(0);
    for (const entry of TIMELINE_KNOWN_FAILURES) {
      expect(entry.key, entry.key).toMatch(/^[a-z-]+\|(webkit|chromium)\|(1280|900|390)$/);
      expect(entry.issue, entry.key).toMatch(/^#\d+$/);
      expect(entry.maxUnexplainedPx ?? entry.maxUnsettledFrames ?? entry.maxGapPx, entry.key).toBeTypeOf("number");
    }
    expect(new Set(TIMELINE_KNOWN_FAILURES.map((entry) => entry.key)).size).toBe(TIMELINE_KNOWN_FAILURES.length);
    // 장면을 못 만드는 까닭은 옛 글 불러오기 결함(#5662)뿐이다.
    for (const entry of TIMELINE_KNOWN_FAILURES.filter((one) => one.notBuilt)) expect(entry.issue).toBe("#5662");
  });

  it("목록의 키 · 이슈 · 상한을 그대로 잠근다 — 줄을 더하거나 상한을 넓히면 이 시험이 바뀐다", () => {
    const shape = TIMELINE_KNOWN_FAILURES.map(({ key, issue, maxUnexplainedPx, maxReversals, maxGapPx, maxUnsettledFrames, maxVanishedFrames, maxPill, notBuilt }) =>
      [key, issue, maxUnexplainedPx ?? null, maxReversals ?? null, maxGapPx ?? null, maxUnsettledFrames ?? null, maxVanishedFrames ?? null, maxPill ?? null, notBuilt ? "notBuilt" : null]
    );
    expect(shape).toEqual(KNOWN_SHAPE);
  });

  it("적지 않은 숫자는 보지 않는 것이 아니라 평소 문턱을 따른다", () => {
    const known = { key: "entry-card|chromium|1280", issue: "#1", maxUnexplainedPx: 5 };
    const numbers = (extra) => ({ reversals: 0, unexplainedPx: 4.75, maxGapPx: 0, pillShows: 0, vanishedFrames: 0, ...extra });
    expect(withinKnown(known, numbers(), { kind: "entry" })).toBe(true);
    expect(withinKnown(known, numbers({ pillShows: 1 }), { kind: "entry" })).toBe(false); // 필 상한을 안 적었으면 0
    expect(withinKnown(known, numbers(), { kind: "entry", unsettled: 1 })).toBe(false); // 자리 잡기 전 프레임 상한을 안 적었으면 0
    expect(withinKnown(known, numbers({ reversals: 1 }), { kind: "entry" })).toBe(false);
    expect(withinKnown({ key: "x|webkit|1280", issue: "#1", maxUnexplainedPx: 2 }, numbers({ unexplainedPx: 1.6, maxGapPx: 2 }), { kind: "bottom" })).toBe(false); // 바닥 거리 평소 1px
    expect(withinKnown(known, numbers({ unexplainedPx: 5.01 }), { kind: "entry" })).toBe(false);
  });

  it("고쳐져 통과하면 「목록에서 빼라」, 못 만들던 칸이 만들어지면 「notBuilt 를 빼라」", () => {
    const list = [
      { key: "entry|chromium|1280", issue: "#1", maxUnsettledFrames: 2 },
      { key: "older|webkit|1280", issue: "#5662", maxUnexplainedPx: 4.5, notBuilt: "옛 쪽이 붙지 않았다(읽기 0" },
    ];
    const cell = (sceneKey, engine, width, verdict) => ({ sceneKey, engine, width, verdict });
    expect(staleKnown([cell("entry", "chromium", 1280, "PASS")], list)[0]).toMatch(/entry\|chromium\|1280\(#1\).*목록에서 빼라/);
    expect(staleKnown([cell("entry", "chromium", 1280, "PASS"), cell("entry", "chromium", 1280, "알려진 실패")], list)).toEqual([]);
    expect(staleKnown([cell("older", "webkit", 1280, "알려진 실패")], list)[0]).toMatch(/#5662.*notBuilt 를 빼라/);
    expect(staleKnown([cell("older", "webkit", 1280, "알려진 실패(장면 못 만듦)")], list)).toEqual([]);
  });
});

describe("마지막 판정 — 0칸 PASS 없음 · 못 만든 칸은 통과가 아님 · 꼭 재야 하는 엔진 (검수 r1 H2 · M4)", () => {
  const pass = { set: "new", scene: "대화 진입", engine: "chromium", width: 1280, verdict: "PASS", kind: "entry", numbers: null };
  const notBuilt = { set: "new", scene: "위로 더 불러오기", engine: "webkit", width: 1280, verdict: "알려진 실패(장면 못 만듦)", known: { issue: "#5662" }, reasons: ["옛 쪽이 붙지 않았다(읽기 0, 목록 높이 +0px)"] };

  it("알려진 「장면 못 만듦」 칸만 고르면 0칸 PASS 가 아니라 FAIL(1)", () => {
    const verdict = finalVerdict([notBuilt, { ...notBuilt, width: 900 }]);
    expect(verdict.code).toBe(1);
    expect(verdict.err.join("\n")).toMatch(/잰 장면이 0개다.*알려진 장면 못 만듦 2/);
    expect(verdict.out.join("\n")).not.toMatch(/PASS/);
  });

  it("잰 칸이 있어도 「장면 못 만듦」이 섞이면 NOT-MEASURED(3)이고 따로 크게 적는다", () => {
    const verdict = finalVerdict([pass, notBuilt]);
    expect(verdict.code).toBe(3);
    expect(verdict.out.join("\n")).toMatch(/!! 재지 못한 칸 — 알려진 장면 못 만듦: 위로 더 불러오기 \[webkit 1280\] #5662/);
    expect(verdict.out.at(-1)).toMatch(/^NOT-MEASURED timeline-still: 재지 않음\(부하\) 0 · 알려진 장면 못 만듦 1 · 엔진 판 없음 0/);
  });

  it("WebKit 판이 없으면 Chromium 이 통과해도 NOT-MEASURED(3), Firefox 판이 없는 것은 기록만", () => {
    const noWebkit = { set: "*", scene: "(모든 장면)", engine: "webkit", width: "*", verdict: "못 잼", required: true, note: "판 없음" };
    expect(finalVerdict([pass, noWebkit]).code).toBe(3);
    expect(finalVerdict([pass, noWebkit]).out.join("\n")).toMatch(/꼭 재야 하는 엔진의 판이 없다: webkit/);
    expect(finalVerdict([pass, { ...noWebkit, engine: "firefox", required: false }]).code).toBe(0);
    expect(finalVerdict([noWebkit, { ...noWebkit, engine: "chromium" }]).code).toBe(1);
  });

  it("부하로 재지 않은 칸이 있으면(모두여도) NOT-MEASURED(3), 기록만 있으면 FAIL(1), 실패가 있으면 FAIL(1)", () => {
    const skipped = { ...pass, verdict: "재지 않음" };
    expect(finalVerdict([skipped, skipped]).code).toBe(3);
    expect(finalVerdict([skipped, notBuilt]).code).toBe(3);
    expect(finalVerdict([{ ...pass, verdict: "기록만(PASS)" }]).code).toBe(1);
    expect(finalVerdict([pass, skipped]).code).toBe(3);
    expect(finalVerdict([pass, { ...pass, verdict: "FAIL", reasons: ["마지막 줄 5px(> 1)"] }]).code).toBe(1);
    const ok = finalVerdict([pass, { ...pass, verdict: "알려진 실패" }]);
    expect(ok.code).toBe(0);
    expect(ok.out.at(-1)).toMatch(/^PASS timeline-still: 판정한 칸 2\(새 장면 2 — 숫자 넷의 문턱 · 기존 묶음 0 — 그 게이트의 판정\) · 알려진 실패 1/);
  });

  it("게이트: 엔진 판이 하나도 없으면 미리보기를 띄우기 전에 「못 잼」 · FAIL(1) — PASS 없음", () => {
    const empty = mkdtempSync(resolve(tmpdir(), "still-nobrowser-"));
    try {
      const run = spawnSync(process.execPath, [resolve(gatesDir, "gate-timeline-still.mjs")], {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty, TIMELINE_STILL_ENGINES: "webkit,chromium", TIMELINE_STILL_PORT: "1" },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/\| \* \| \(모든 장면\) \| webkit \| \* \| 못 잼 \|/);
      expect(run.stderr).toMatch(/FAIL timeline-still: 잰 장면이 0개다 — 0번 돌고 통과할 수 없다 \(재지 않음\(부하\) 0 · 알려진 장면 못 만듦 0 · 엔진 판 없음 2\)/);
      expect(run.stdout).not.toMatch(/PASS timeline-still/);
    } finally {
      rmSync(empty, { recursive: true });
    }
  }, 60_000);
});

// 기록기 자체: 실제 브라우저에서, 그리기 단계 안에서 생기는 한 프레임 모양(진입의 첫 프레임 · 주입한 흔들림)을 놓치지 않는가.
// 번들 · 서버 없이 Playwright 의 판만 쓴다. 판이 캐시에 없는 엔진은 건너뛴다(웹 레인의 *.chromium.test.ts 와 같은 규칙 — 건너뜀으로 센다).
const ENGINES = { chromium, webkit };
const PAGE = `<!doctype html><html><body style="margin:0"><div id="trig" style="width:1px;height:1px"></div>
<div id="sc" style="height:300px;overflow:auto"></div><script>
window.row = (i) => { const r = document.createElement("div"); r.setAttribute("data-index", String(i)); r.style.height = "40px";
  const m = document.createElement("div"); m.setAttribute("data-message-id", "0199eee-" + i); m.textContent = "줄 " + i; r.appendChild(m); return r; };
// 가상 목록 흉내: 페이지가 뜰 때 만든 관찰자(기록기의 관찰자보다 먼저 돈다)가 그리기 단계 안에서 「붙은 뒤 바로잡기」를 한다.
window.fixer = new ResizeObserver(() => { if (window.fix) { const f = window.fix; window.fix = null; f(); } });
window.fixer.observe(document.getElementById("trig"));
window.kick = (f) => { window.fix = f; const t = document.getElementById("trig"); t.style.width = t.style.width === "1px" ? "2px" : "1px"; };
</script></body></html>`;

describe.each(Object.keys(ENGINES))("기록기 — 그리기 직전 표본 (%s, 검수 r1 H1 · M1)", (engine) => {
  const present = existsSync(ENGINES[engine].executablePath());
  const withPage = async (body) => {
    const browser = await ENGINES[engine].launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
      await page.route("http://still.test/", (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
      await body(page);
    } finally {
      await browser.close();
    }
  };

  it.skipIf(!present)("진입: 줄이 맨 위(가장 새 줄 없음)로 붙은 첫 프레임을 센다", async () => {
    await withPage(async (page) => {
      await installEntryRecorder(page, { scroller: "#sc", startSelector: '[data-message-id^="0199eee"]', messageId: "0199eee-29", name: "last", edge: "bottom", windowMs: 400 });
      await page.goto("http://still.test/");
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        // 한 프레임(rAF 안): 첫 쪽 앞부분만 붙고 맨 위. 다음 프레임에 관찰자가 나머지를 붙이고 바닥으로 바로잡는다(실측 Chromium 의 모양).
        requestAnimationFrame(() => {
          const sc = document.getElementById("sc");
          for (let i = 0; i < 10; i += 1) sc.appendChild(window.row(i));
          requestAnimationFrame(() =>
            window.kick(() => {
              for (let i = 10; i < 30; i += 1) sc.appendChild(window.row(i));
              sc.scrollTop = sc.scrollHeight;
            })
          );
        });
      });
      const record = await readEntryRecord(page, 10_000, 400);
      expect(record.frames[0].top).toBe(0);
      expect(record.frames[0].watch.last).toBeNull();
      expect(record.frames.filter((frame) => frame.watch.last === null).length).toBeGreaterThanOrEqual(1);
      expect(record.frames.at(-1).watch.last).not.toBeNull();
      expect(frameGaps(record.frames).reason).toBeNull();
    });
  }, 30_000);

  it.skipIf(!present)("주입한 한 프레임 5px(rAF 안 · 다른 관찰자 콜백 안)을 잡는다", async () => {
    await withPage(async (page) => {
      await page.goto("http://still.test/");
      await page.evaluate(() => {
        const sc = document.getElementById("sc");
        for (let i = 0; i < 30; i += 1) sc.appendChild(window.row(i));
        sc.scrollTop = sc.scrollHeight;
      });
      for (const where of ["raf", "observer"]) {
        await startStillRecorder(page, { scroller: "#sc", watch: [{ name: "w", messageId: "0199eee-29", edge: "bottom" }] });
        await page.waitForTimeout(150);
        await page.evaluate((where) => {
          const row = document.querySelector('[data-message-id="0199eee-29"]').parentElement;
          const jolt = () => {
            row.style.transform = "translateY(5px)";
            requestAnimationFrame(() => (row.style.transform = ""));
          };
          if (where === "raf") requestAnimationFrame(jolt);
          else window.kick(jolt);
        }, where);
        await page.waitForTimeout(250);
        const record = await stopStillRecorder(page);
        const numbers = numbersFromRecord(record, { watch: "w" });
        expect(numbers.unexplainedPx, where).toBe(5);
        expect(numbers.reversals, where).toBe(1);
        expect(judgeCell(numbers, { kind: "bottom", minSamples: 3 }).verdict, where).toBe("FAIL");
      }
    });
  }, 30_000);
});
