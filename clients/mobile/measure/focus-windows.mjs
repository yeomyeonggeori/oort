#!/usr/bin/env node
/**
 * `measure/steady.tsx` 의 `focus` 장면(`DM-STEADY-FOCUS`, 흐름 `maestro/109-focus-steady.yaml`)이 `-momoGapSink` 로 보낸 프레임을
 * 사건(포커스·블러·보냄·초안·자판) 둘레의 **창**으로 잘라 「맨 아래 행이 입력창 높이가 바뀐 만큼만 움직였는가」를 숫자로 낸다 (#4456).
 *
 *   node measure/focus-windows.mjs <sink.jsonl> [--tag <태그>] [--table <사건 이름 앞부분, 예: focus>] [--json]
 *
 * 한 프레임에서 앱이 재는 것(창 좌표, pt): `dock`(도크 윗면) · `dockH`(도크 높이) · `tail`(목록 꼬리 = 마지막 행 바로 아래) · `anchor`(장면 시작 때의
 * 마지막 행 아랫면). 자판이 오르내릴 때 대화 틀 전체가 같이 미끄러지므로(`ConversationLayout`) 절대 좌표는 그 이동을 품는다 — 그래서 판정은
 * **틈 = 도크 윗면 − 목록 꼬리**가 사건 직전 값에서 얼마나 벗어났는가로 한다. 맨 아래 행이 도크를 정확히 따라가면 틈은 변하지 않는다:
 *
 *   틈 편차 < 0   마지막 행이 도크 밑으로 들어갔다(가려졌다)      — 도크가 먼저 자라고 목록이 한 걸음 늦게 따라온 프레임
 *   틈 편차 > 0   마지막 행과 도크 사이가 벌어졌다                — 도크가 줄고 목록이 한 걸음 늦게 따라온 프레임
 *
 * 창 안의 나머지 숫자: 도크 높이 시작→끝, 도크 윗면·목록 꼬리의 순이동, 두 값의 방향 뒤집힘 횟수(출렁임), 프레임 간격(부하 표지).
 * 의존성 없음.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
// 이 레포의 eslint(espree 기본)는 `??` 를 읽지 못한다 — 널 병합은 이 함수로 쓴다.
const or = (value, fallback) => (value === undefined || value === null ? fallback : value);
const file = args.find(arg => !arg.startsWith('--'));
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : or(args[index + 1], true);
};
if (!file) {
  console.error('usage: node measure/focus-windows.mjs <sink.jsonl> [--tag <태그>] [--table <사건 이름 앞부분>] [--json]');
  process.exit(2);
}
const wantTag = flag('--tag');
const tableFor = flag('--table');
const asJson = args.includes('--json');

const PRE_MS = 150;
const POST_MS = 900;
const SETTLE_PT = 1;

const records = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line))
  .filter(record => record.scenario === 'focus' && Array.isArray(record.trace) && (wantTag === null || record.tag === wantTag));

const round = value => Math.round(value * 10) / 10;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};
const reversals = values => {
  let last = 0;
  let count = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (Math.abs(delta) <= 0.5) continue;
    const direction = delta > 0 ? 1 : -1;
    if (last !== 0 && direction !== last) count += 1;
    last = direction;
  }
  return count;
};

const out = [];
for (const record of records) {
  const trace = record.trace.filter(frame => frame.dock !== null && frame.tail !== null && frame.dockH !== null);
  const events = or(record.events, []);
  const keyboard = events.filter(event => event.what.startsWith('keyboard'));
  const dts = trace.slice(1).map((frame, index) => frame.t - trace[index].t);
  const interval = {
    frames: trace.length,
    medianMs: round(or(median(dts), 0)),
    p95Ms: round(or([...dts].sort((a, b) => a - b)[Math.floor(dts.length * 0.95)], 0)),
    over50Ms: dts.filter(dt => dt > 50).length,
  };
  const windows = [];
  const counters = {};
  let lastDraft = null;
  for (const event of events) {
    const kind = event.what.startsWith('draft-') ? 'draft' : event.what;
    if (!['focus', 'blur', 'sent', 'draft'].includes(kind)) continue;
    // 글자 하나마다 초안 표식이 남는다 — 줄 수가 바뀐 표식만 창으로 자른다.
    if (kind === 'draft') {
      if (event.what === lastDraft) continue;
      lastDraft = event.what;
    }
    counters[kind] = or(counters[kind], 0) + 1;
    const from = event.t - PRE_MS;
    const to = event.t + POST_MS;
    const frames = trace.filter(frame => frame.t >= from && frame.t <= to);
    const before = frames.filter(frame => frame.t < event.t);
    const after = frames.filter(frame => frame.t >= event.t);
    if (before.length === 0 || after.length < 3) continue;
    const base = before[before.length - 1];
    const gap0 = base.dock - base.tail;
    const gapAnchor0 = base.dock - base.anchor;
    const devs = after.map(frame => ({t: frame.t - event.t, dev: frame.dock - frame.tail - gap0, devAnchor: frame.dock - frame.anchor - gapAnchor0}));
    const tailEnd = median(after.slice(-6).map(frame => frame.tail));
    const dockEnd = median(after.slice(-6).map(frame => frame.dock));
    const dockHEnd = median(after.slice(-6).map(frame => frame.dockH));
    const lastBad = [...devs].reverse().find(entry => Math.abs(entry.dev) > SETTLE_PT);
    const kb = keyboard.filter(k => k.t >= event.t - 400 && k.t <= event.t + 400).map(k => `${k.what}@${k.t - event.t}`);
    const minDev = Math.min(...devs.map(entry => entry.dev));
    const maxDev = Math.max(...devs.map(entry => entry.dev));
    windows.push({
      event: kind === 'draft' ? event.what.replace('draft-', 'd-').replace('-lines', 'L') : `${kind}#${counters[kind]}`,
      what: event.what,
      atMs: event.t,
      keyboard: kb,
      dockH: [round(base.dockH), round(dockHEnd)],
      dockHDelta: round(dockHEnd - base.dockH),
      dockNet: round(dockEnd - base.dock),
      tailNet: round(tailEnd - base.tail),
      gapStart: round(gap0),
      gapDevMin: round(minDev),
      gapDevMax: round(maxDev),
      gapDevFrames: devs.filter(entry => Math.abs(entry.dev) > SETTLE_PT).length,
      settledAfterMs: lastBad === undefined ? 0 : round(lastBad.t),
      anchorDevMin: round(Math.min(...devs.map(entry => entry.devAnchor))),
      anchorDevMax: round(Math.max(...devs.map(entry => entry.devAnchor))),
      dockHReversals: reversals(after.map(frame => frame.dockH)),
      tailReversals: reversals(after.map(frame => frame.tail)),
      firstDockHChangeMs: (() => {
        const moved = after.find(frame => Math.abs(frame.dockH - base.dockH) > 0.5);
        return moved === undefined ? null : round(moved.t - event.t);
      })(),
      maxDockHStep: round(Math.max(0, ...after.slice(1).map((frame, index) => Math.abs(frame.dockH - after[index].dockH)))),
      focusedAtEvent: after[0].focused,
    });
    if (tableFor !== null && event.what.startsWith(tableFor === true ? 'focus' : tableFor)) {
      out.push({table: `${record.tag} ${kind}#${counters[kind]} @${event.t}ms`, rows: frames.map(frame => ({t: frame.t - event.t, foc: frame.focused ? 1 : 0, dock: round(frame.dock), dockH: round(frame.dockH), tail: round(frame.tail), gap: round(frame.dock - frame.tail), dev: round(frame.dock - frame.tail - gap0)}))});
    }
  }
  out.push({tag: record.tag, durationMs: record.durationMs, interval, events: events.length, windows});
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const entry of out) {
    if (entry.table) {
      console.log(`\n# ${entry.table}`);
      console.log('   t(ms) foc    dock  dockH    tail    gap    dev');
      for (const row of entry.rows) {
        console.log(`${String(row.t).padStart(8)} ${String(row.foc).padStart(3)} ${String(row.dock).padStart(7)} ${String(row.dockH).padStart(6)} ${String(row.tail).padStart(7)} ${String(row.gap).padStart(6)} ${String(row.dev).padStart(6)}`);
      }
      continue;
    }
    console.log(`\n== ${entry.tag}  (${entry.durationMs}ms, ${entry.interval.frames}프레임, 간격 중앙 ${entry.interval.medianMs}ms · p95 ${entry.interval.p95Ms}ms · 50ms 초과 ${entry.interval.over50Ms}회)`);
    console.log('사건        dockH(pt)         Δ     dock순이동 tail순이동 | 틈편차 min  max  (|편차|>1: 프레임, 안정까지 ms) | 뒤집힘 dockH/tail | 높이 첫 변화 ms · 최대 한걸음 | 자판');
    for (const w of entry.windows) {
      const head = `${w.event.padEnd(10)} ${String(w.dockH[0]).padStart(6)}→${String(w.dockH[1]).padEnd(6)} ${String(w.dockHDelta).padStart(6)}  ${String(w.dockNet).padStart(8)} ${String(w.tailNet).padStart(9)}`;
      const gap = `${String(w.gapDevMin).padStart(6)} ${String(w.gapDevMax).padStart(5)}  (${w.gapDevFrames}f, ${w.settledAfterMs}ms)`;
      console.log(`${head} | ${gap} | ${w.dockHReversals}/${w.tailReversals} | ${or(w.firstDockHChangeMs, '-')} · ${w.maxDockHStep} | ${w.keyboard.join(' ')}`);
    }
  }
}
