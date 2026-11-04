import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

// =============================================================================
// 줄 잘림 측정 도구의 검사기가 **실제로 어길 수 있는가** (#5288, #4894).
//
// `measure/sentence-wrap-check.mjs`(전략별 잰 줄 ↔ 그린 줄)와 `measure/bubble-clip-check.mjs` 의 단정 I(말풍선 줄 빠짐)는 시뮬레이터가
// 낸 숫자를 읽어 종료 코드로 답한다. 검사기가 늘 통과하면 하네스의 초록은 아무것도 증명하지 않는다 — 그래서 손으로 만든 기록으로
// 위반을 먹여 빨개지는지, 깨끗한 기록에는 초록인지, 못 잰 기록(빈 보고·done 없음)은 통과가 아니라 실패인지를 센다.
// =============================================================================

const MEASURE = resolve(__dirname, '../measure');
const SENTENCE_CHECK = join(MEASURE, 'sentence-wrap-check.mjs');
const BUBBLE_CHECK = join(MEASURE, 'bubble-clip-check.mjs');

type Rec = Record<string, unknown>;

function run(script: string, records: Rec[], flags: string[] = []): {code: number | null; out: string} {
  const dir = mkdtempSync(join(tmpdir(), 'wrap-check-'));
  const file = join(dir, 'records.jsonl');
  writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  try {
    const result = spawnSync(process.execPath, [script, 'check', file, ...flags], {encoding: 'utf8'});
    return {code: result.status, out: `${result.stdout}${result.stderr}`};
  } finally {
    unlinkSync(file);
    rmdirSync(dir);
  }
}

// ---- sentence-wrap-check ----------------------------------------------------------------------------------------

const EN_LINES = [
  {w: 323.1, t: 'An approval alert is one question, and a one-'},
  {w: 248.1, t: 'line receipt stays after you decide.'},
];
function wrapCase(over: Rec = {}): Rec {
  return {
    surface: 'sentence-wrap', kind: 'case', id: 'en-notif-3', set: 'en', strategy: 'sentence', W: 337.3333, base: 0, rep: 0,
    wrapY: 100, len: 81, lineH: 23, layoutW: 337.333, layoutH: 46, shave: 0, expected: 2, n: 2, maxRight: 323.1, lines: EN_LINES, ...over,
  };
}
const wrapDone = (total: number): Rec => ({surface: 'sentence-wrap', kind: 'done', total, bad: 0, fontScale: 1});

describe('sentence-wrap-check — 잰 줄 수 ↔ 그린 줄 수', () => {
  it('깨끗한 기록은 초록이다', () => {
    const {code, out} = run(SENTENCE_CHECK, [wrapCase(), wrapCase({strategy: 'unset'}), wrapDone(2)], ['--clean', 'sentence,unset']);
    expect(out).toContain('RESULT OK');
    expect(code).toBe(0);
  });

  it('잰 높이는 두 줄인데 한 줄만 그린 칸(A)은 `--clean` 전략에서 빨갛다 — 줄바꿈 없이 통째로 한 줄이 된 모습 그대로', () => {
    const clipped = wrapCase({
      layoutH: 45.999756, shave: 0.000244, n: 1, maxRight: 337.333,
      lines: [{w: 337.333, t: 'An approval alert is one question, and a one-line receipt stays after you decide.'}],
    });
    const {code, out} = run(SENTENCE_CHECK, [clipped, wrapDone(1)], ['--clean', 'sentence']);
    expect(out).toMatch(/--clean sentence: A 1/);
    expect(code).toBe(1);
    // 깨뜨리면(검사기가 n ≠ expected 를 안 센다) → 이 단정이 빨개진다.
  });

  it('`--clean` 에 안 준 전략의 위반은 표에만 찍고 통과한다 — 맨몸 전략이 빨간 것은 증상의 증거이지 실패가 아니다', () => {
    const clipped = wrapCase({strategy: 'unset', n: 1, shave: 0.000244});
    const {code, out} = run(SENTENCE_CHECK, [wrapCase(), clipped, wrapDone(2)], ['--clean', 'sentence']);
    expect(out).toMatch(/unset\s+1\s+1/); // 칸 1, A 1
    expect(code).toBe(0);
  });

  it('못 잰 것은 통과가 아니다 — 끝 기록이 없거나, 틀·줄 보고가 비었거나, `--clean` 전략의 칸이 하나도 없으면 실패다', () => {
    expect(run(SENTENCE_CHECK, [wrapCase()]).code).toBe(1); // done 없음
    const empty = wrapCase({layoutH: null, n: 0, expected: null, lines: []});
    const emptyRun = run(SENTENCE_CHECK, [empty, wrapDone(1)], ['--clean', 'sentence']);
    expect(emptyRun.out).toMatch(/E 1/);
    expect(emptyRun.code).toBe(1);
    const noCells = run(SENTENCE_CHECK, [wrapCase({strategy: 'unset'}), wrapDone(1)], ['--clean', 'sentence']);
    expect(noCells.out).toContain('빈 훑기');
    expect(noCells.code).toBe(1);
    expect(run(SENTENCE_CHECK, [wrapCase(), wrapDone(1)], ['--min-cases', '5']).code).toBe(1);
  });

  it('다른 도구가 같은 받는 쪽으로 보낸 기록은 세지 않는다', () => {
    const foreign = {surface: 'sentence-probe', kind: 'case', ev: 'layout', key: 'x'};
    const {code, out} = run(SENTENCE_CHECK, [foreign, wrapCase(), wrapDone(1)], ['--clean', 'sentence']);
    expect(out).toContain('cases=1');
    expect(code).toBe(0);
  });

  it('한글 글의 마지막 줄이 한 글자뿐이면(고아) `--no-orphans` 전략에서만 빨갛다 — 영어 한 글자 줄은 세지 않는다', () => {
    const ko = wrapCase({
      id: 'ko', set: 'ko', lines: [{w: 300, t: '승인 알림은 질문 한 문장으로 오고, 결정한 뒤에는 한 줄 영수증이 남아'}, {w: 16, t: '요'}],
    });
    const en = wrapCase({id: 'en', lines: [{w: 300, t: 'An approval alert is one question, and a one-line receipt stays after you decide'}, {w: 8, t: 'a'}]});
    const withOrphan = run(SENTENCE_CHECK, [ko, wrapDone(1)], ['--no-orphans', 'sentence']);
    expect(withOrphan.out).toMatch(/한 글자 고아 줄 1개/);
    expect(withOrphan.code).toBe(1);
    expect(run(SENTENCE_CHECK, [ko, wrapDone(1)]).code).toBe(0); // 옵션이 없으면 표만
    expect(run(SENTENCE_CHECK, [en, wrapDone(1)], ['--no-orphans', 'sentence']).code).toBe(0);
  });
});

// ---- bubble-clip-check 단정 I -------------------------------------------------------------------------------------

function bubbleCase(over: {text?: Rec; lines?: Rec} = {}): Rec {
  return {
    kind: 'case', id: 'l5d-mention', set: 'md', base: 8000.3333, rep: 32, who: 'mine', row: false, W: 402, fontScale: 1, pixelRatio: 3,
    padX: 12, padY: 8, colW: 320,
    bubbles: [{key: '0', x: 0, w: 320, h: 62}],
    paras: [
      {
        key: '0.0',
        text: {x: 0, w: 296, h: 46, ...over.text},
        lines: {n: 2, chars: 59, maxRight: 290, bottom: 46, lineH: 22.99, ...over.lines},
      },
    ],
  };
}
const bubbleDone = (total: number): Rec => ({kind: 'done', total, bad: 0});

describe('bubble-clip-check — 단정 I(줄이 빠지지 않는다)', () => {
  it('글 상자 높이만큼 줄이 그려졌으면 통과한다', () => {
    const {code, out} = run(BUBBLE_CHECK, [bubbleCase(), bubbleDone(1)]);
    expect(out).toContain('RESULT: PASS');
    expect(code).toBe(0);
  });

  it('두 줄 높이인데 한 줄만 그려진 칸(5a 의 말풍선)은 I 로 빨갛다 — A~H 는 그 칸을 놓친다', () => {
    const clipped = bubbleCase({lines: {n: 1, bottom: 22.99, maxRight: 296}});
    const {code, out} = run(BUBBLE_CHECK, [clipped, bubbleDone(1)]);
    expect(out).toMatch(/I 문단 0\.0: 글 상자 높이 46 인데 그린 줄은 1줄/);
    expect(code).toBe(1);
    // 깨뜨리면(단정 I 를 지운다) → 이 칸이 통과해 이 단정이 빨개진다(수리 전 말풍선 12칸이 그렇게 지나갔다).
  });

  it('반 줄 안쪽의 차이는 허용하고 반 줄을 넘으면 어긴다 — 줄 높이를 모르는 옛 기록은 건너뛴다', () => {
    expect(run(BUBBLE_CHECK, [bubbleCase({text: {h: 46}, lines: {bottom: 35}}), bubbleDone(1)]).code).toBe(0); // 11 < 11.495
    expect(run(BUBBLE_CHECK, [bubbleCase({text: {h: 46}, lines: {bottom: 34}}), bubbleDone(1)]).code).toBe(1); // 12 > 11.495
    expect(run(BUBBLE_CHECK, [bubbleCase({lines: {n: 1, bottom: 22.99, lineH: null}}), bubbleDone(1)]).code).toBe(0);
  });
});
