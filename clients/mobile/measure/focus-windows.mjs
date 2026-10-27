#!/usr/bin/env node
/**
 * `measure/steady.tsx` 의 `focus` 장면(`DM-STEADY-FOCUS`, 흐름 `maestro/110-focus-steady.yaml`)이 `-momoGapSink` 로 보낸 프레임을
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
 *
 * #4614 `dismiss` 창: `DM-STEADY-FOCUS+actions` 장면(`maestro/116-list-tap-rest.yaml`, 구동기 `run-list-rest.sh`)은 목록을 눌러 `Keyboard.dismiss` 가 불린 순간을 `dismiss` 표식으로 남긴다 — 입력창이
 * 쉬러 가는 첫 순간이다. 그 창에서 읽는 것: 틈 편차(목록 꼬리가 도크가 줄어든 만큼만 같이 움직였는가), 뒤집힘(0 이어야 한다), **최대 한 걸음**(한 프레임에 도크 높이가 뛴 가장 큰 양 — 사건 직전 마지막
 * 프레임에서 사건 뒤 첫 프레임으로 가는 걸음도 센다. 스프링으로 줄면 프레임당 한 자릿수~십수 pt 이고, 글 칸이 한 프레임에 줄면 그 줄어든 양 전부가 한 걸음으로 나온다).
 * `+draft<N>` 은 N줄 초안을 들고 시작해 키 큰 입력창을 세운다(타자로 친 줄은 이 빌드에서 입력창을 못 키운다 — #4615).
 *
 * #4518 「누름 → 자판」 창: 입력창은 이제 포커스가 아니라 **손이 닿는 순간**(`touch-down` 표식) 펼침을 시작하므로 `focus` 사건 둘레 창으로는 시작 시각을 잴 수 없다
 * (그 프레임들은 이미 움직이는 중이다). 그래서 `keyboardWillShow`(높이 > 0) 하나마다 앞선 `touch-down` 을 짝지어 별도 줄로 낸다:
 *   - 닿음→자판 ms        손이 닿은 때부터 iOS 가 자판을 올린다고 알려 온 때까지(탭 길이 + 네이티브 지연)
 *   - 첫 변화             도크 높이가 닿기 직전 값에서 0.5pt 넘게 벗어난 첫 프레임 — 닿음 기준 ms(프레임 수) · **자판 기준 ms (음수 = 펼침이 자판보다 앞선다)**
 *   - 자판 시점 펼침 %    `keyboardWillShow` 직전 프레임에서 도크가 끝값의 몇 %까지 자랐는가
 *   - 목록 구간 · 멈춤    목록 꼬리가 움직인 구간 수와 구간 사이 가장 긴 멈춤(프레임). 펼침이 먼저 끝나고 자판이 따로 오르면 구간이 둘이 된다
 *   - 렌더              닿음부터 `keyboardWillShow` 직후까지 컴포저가 다시 그려진 커밋(React `Profiler`, 표식 `render-<phase>-<ms>ms`): 닿음 뒤 몇 ms 에 어떤 커밋이 몇 ms 걸렸는가(누름 시작의 렌더 비용)
 * 이 줄의 기준은 **JS 가 받은 시각**이다(터치·자판 이벤트·프레임 모두 같은 `Date.now()` 시계 — 서로의 차는 믿을 수 있고 네이티브 절대 시각은 아니다).
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
    const kind = event.what.startsWith('draft-')
      ? 'draft'
      : event.what.startsWith('touch-down')
        ? 'touch-down'
        : event.what.startsWith('touch-drag')
          ? 'touch-drag'
          : event.what;
    // `dismiss`(#4614 `+actions`): 목록을 눌러 `Keyboard.dismiss` 가 불린 순간 = 입력창이 쉬러 가는 첫 순간.
    if (!['focus', 'blur', 'sent', 'draft', 'touch-down', 'touch-drag', 'touch-up', 'touch-cancel', 'dismiss'].includes(kind)) continue;
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
      // 사건 **직전 마지막 프레임**(`base`)에서 사건 뒤 첫 프레임으로 가는 한 걸음도 센다(#4614): 입력창이 사건 순간 한 프레임에 줄어드는 단차는 정확히 그 걸음이다.
      // (전에는 `after` 안의 걸음만 세서, 사건 프레임에서 뛴 높이를 못 봤다 — 틈 편차(`gapDevMax`)만 그 단차를 알렸다.)
      maxDockHStep: round(Math.max(0, ...[base, ...after].slice(1).map((frame, index) => Math.abs(frame.dockH - [base, ...after][index].dockH)))),
      focusedAtEvent: after[0].focused,
    });
    if (tableFor !== null && event.what.startsWith(tableFor === true ? 'focus' : tableFor)) {
      out.push({table: `${record.tag} ${kind}#${counters[kind]} @${event.t}ms`, rows: frames.map(frame => ({t: frame.t - event.t, foc: frame.focused ? 1 : 0, dock: round(frame.dock), dockH: round(frame.dockH), tail: round(frame.tail), gap: round(frame.dock - frame.tail), dev: round(frame.dock - frame.tail - gap0)}))});
    }
  }
  // ---- #4518 누름 → 자판 창 -------------------------------------------------
  const presses = [];
  let kbIndex = 0;
  for (const event of events) {
    if (!event.what.startsWith('keyboardWillShow')) continue;
    const match = /-h(\d+)-d(\d+)/.exec(event.what);
    const kbH = match === null ? 0 : Number(match[1]);
    const kbMs = match === null ? 0 : Number(match[2]);
    // 높이 0 은 하드웨어 키보드·백그라운드 복귀 — 올라오는 자판이 아니다.
    if (kbH === 0) continue;
    kbIndex += 1;
    const downs = events.filter(other => other.what.startsWith('touch-down') && other.t <= event.t && event.t - other.t <= 1500);
    const down = downs.length === 0 ? null : downs[downs.length - 1];
    const t0 = down === null ? event.t - 600 : down.t;
    const baseFrames = trace.filter(frame => frame.t < t0);
    if (baseFrames.length < 3) continue;
    const baseH = median(baseFrames.slice(-6).map(frame => frame.dockH));
    const baseGap = median(baseFrames.slice(-6).map(frame => frame.dock - frame.tail));
    const endFrames = trace.filter(frame => frame.t >= t0 && frame.t <= event.t + POST_MS);
    if (endFrames.length < 6) continue;
    const endH = median(endFrames.slice(-6).map(frame => frame.dockH));
    const changed = endFrames.find(frame => Math.abs(frame.dockH - baseH) > 0.5);
    const atKb = trace.filter(frame => frame.t <= event.t).pop();
    const focusEvent = events.find(other => other.what === 'focus' && other.t >= event.t - 600 && other.t <= event.t + 600);
    const framesToChange = changed === undefined ? null : trace.filter(frame => frame.t >= t0 && frame.t < changed.t).length;
    const renders = events
      .filter(other => other.what.startsWith('render-') && other.t >= t0 && other.t <= event.t + 100)
      .map(other => `+${other.t - t0}ms ${other.what.replace('render-', '')}`);
    // 목록 꼬리가 움직인 구간: 0.5pt 넘게 움직인 프레임이 이어지는 덩어리. 멈춘 프레임이 3개(≥ 50ms) 이상 끼면 구간이 갈린다.
    const tails = endFrames.map(frame => frame.tail);
    const moving = tails.slice(1).map((value, index) => Math.abs(value - tails[index]) > 0.5);
    let bursts = 0;
    let longestPause = 0;
    let pause = 0;
    let inBurst = false;
    let seenMove = false;
    let lastMoveIndex = -1;
    moving.forEach((isMoving, index) => {
      if (isMoving) {
        if (!inBurst || pause >= 3) bursts += 1;
        if (seenMove && pause > longestPause && pause >= 1) longestPause = pause;
        inBurst = true;
        seenMove = true;
        pause = 0;
        lastMoveIndex = index;
      } else if (inBurst) {
        pause += 1;
      }
    });
    // 맨 뒤의 멈춤은 「끝난 뒤」라 구간 사이 멈춤이 아니다(위 반복에서 다음 움직임이 와야 longestPause 로 센다).
    const gapDevs = endFrames.map(frame => frame.dock - frame.tail - baseGap);
    presses.push({
      n: kbIndex,
      kbH,
      kbMs,
      touchToKbMs: down === null ? null : event.t - down.t,
      focusVsKbMs: focusEvent === undefined ? null : focusEvent.t - event.t,
      firstChangeFromTouchMs: down === null || changed === undefined ? null : round(changed.t - down.t),
      framesToChange,
      firstChangeVsKbMs: changed === undefined ? null : round(changed.t - event.t),
      dockHDelta: round(endH - baseH),
      dockPctAtKb: atKb === undefined || endH === baseH ? null : Math.round((100 * (atKb.dockH - baseH)) / (endH - baseH)),
      tailBursts: bursts,
      tailLongestPauseFrames: longestPause,
      lastTailMoveMs: lastMoveIndex < 0 ? null : round(endFrames[lastMoveIndex + 1].t - t0),
      gapDevMin: round(Math.min(...gapDevs)),
      gapDevMax: round(Math.max(...gapDevs)),
      renders,
    });
  }
  out.push({tag: record.tag, durationMs: record.durationMs, interval, events: events.length, windows, presses});
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
    if (entry.presses.length > 0) {
      console.log('\n누름→자판 (키보드 길이·높이 | 닿음→자판 ms | 첫 변화: 닿음 기준 ms(프레임) · 자판 기준 ms[음수=앞섬] | 포커스 이벤트(자판 기준 ms) | 자판 시점 펼침 % · Δ높이 | 목록 구간 수 · 가장 긴 멈춤(프레임) · 끝까지 ms | 틈편차 | 렌더 커밋)');
      for (const press of entry.presses) {
        const first = press.firstChangeFromTouchMs === null && press.firstChangeVsKbMs === null ? '변화 없음' : `${or(press.firstChangeFromTouchMs, '-')}ms(${or(press.framesToChange, '-')}f) · ${or(press.firstChangeVsKbMs, '-')}ms`;
        console.log(`kb#${press.n} d${press.kbMs}/h${press.kbH} | ${or(press.touchToKbMs, '-')} | ${first} | ${or(press.focusVsKbMs, '-')} | ${or(press.dockPctAtKb, '-')}% · ${press.dockHDelta} | ${press.tailBursts} · ${press.tailLongestPauseFrames}f · ${or(press.lastTailMoveMs, '-')} | ${press.gapDevMin}~${press.gapDevMax} | ${press.renders.join(', ')}`);
      }
    }
  }
}
