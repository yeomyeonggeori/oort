#!/usr/bin/env node
/**
 * `measure/steady.tsx` 의 `enter` 장면(`DM-STEADY-ENTER[+age17h|+nobar|+label|+T<초>]`, 흐름 `maestro/112-enter-steady.yaml`)이 `-momoGapSink` 로 보낸
 * 기록을 **네 창**으로 잘라 「대화 진입·입력 초반의 떨림」을 숫자로 낸다 (#4613).
 *
 *   node measure/enter-windows.mjs <sink.jsonl> [--tag <태그>] [--json] [--eps <pt>]
 *
 * 문턱은 **둘을 나란히** 낸다: 0.5pt(하네스 기본 `MOVE_EPSILON_PT`)와 0.01pt(「0」이 필터 때문인지 가르는 값 — 3x 기기의 한 픽셀은 0.33pt 라 0.5 문턱은 실기에서
 * 보이는 떨림을 지울 수 있다). 표의 `a/b` 는 0.5 문턱 / 0.01 문턱이다.
 *
 * 창:
 *   진입   마운트(t=0)부터 첫 `touch-down` 까지. 목록이 끝에 앉는 동안: 맨 아래 행 이동 구간·방향 반전·`status` 전이·`chasingTail` 전이(떼고 붙인 횟수)·
 *          스크롤 보고(손가락/목록이 낸 것)·**꼬리 고정 횟수**(목록이 스스로 낸 보고를 250ms 쉼으로 끊은 묶음 수).
 *   누름   `touch-down` 부터 1.5초. 도크·입력창·목록 높이 변화, 맨 아래 행 이동과 **입력창 성장분 − 이동**(틈 = 도크 윗면 − 목록 꼬리의 편차), 반전.
 *   글자   `chars-N` 표식 둘레(−100…+700ms)마다. 같은 지표.
 *   초 단위  마지막 글자 3초 뒤부터 보내기 누름(마지막 햅틱 = 양성 대조) 전까지. **근거 글(`txt:`)이 바뀐 순간마다** 120ms 안에 맨 아래 행·활동 줄 높이·도크 높이가 움직였는가,
 *          활동 줄 높이가 바뀐 횟수(= 줄 수가 뒤집힌 횟수)와 그때의 글.
 * 그 밖에: 알약이 선 프레임 수와 **프로그램 스크롤 중에 선 프레임**, 햅틱 호출, rAF 간격(메인 스레드 정체 표지).
 * 의존성 없음.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const or = (value, fallback) => (value === undefined || value === null ? fallback : value);
const file = args.find(arg => !arg.startsWith('--'));
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : or(args[index + 1], true);
};
if (!file) {
  console.error('usage: node measure/enter-windows.mjs <sink.jsonl> [--tag <태그>] [--json]');
  process.exit(2);
}
const wantTag = flag('--tag');
const asJson = args.includes('--json');
const EPS = [0.5, 0.01];

const records = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line))
  .filter(record => record.scenario === 'enter' && Array.isArray(record.trace) && (wantTag === null || record.tag === wantTag));

const round = value => Math.round(value * 100) / 100;
const num = value => typeof value === 'number' && Number.isFinite(value);

/** 한 값 계열의 이동 요약: 문턱 위로 움직인 프레임 수·이동량 합·가장 큰 한 걸음·방향 반전·범위·순이동. */
function series(frames, pick, eps) {
  const points = frames.filter(frame => num(pick(frame))).map(frame => ({t: frame.t, v: pick(frame)}));
  let moves = 0;
  let travel = 0;
  let maxStep = 0;
  let reversals = 0;
  let last = 0;
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].v - points[index - 1].v;
    const size = Math.abs(delta);
    if (size <= eps) continue;
    moves += 1;
    travel += size;
    maxStep = Math.max(maxStep, size);
    const direction = delta > 0 ? 1 : -1;
    if (last !== 0 && direction !== last) reversals += 1;
    last = direction;
  }
  const values = points.map(point => point.v);
  return {
    n: points.length,
    moves,
    travel: round(travel),
    maxStep: round(maxStep),
    reversals,
    range: values.length === 0 ? null : round(Math.max(...values) - Math.min(...values)),
    net: values.length < 2 ? null : round(values[values.length - 1] - values[0]),
  };
}

const both = (frames, pick) => EPS.map(eps => series(frames, pick, eps));
const fmt = (pair, key) => `${pair[0][key]}/${pair[1][key]}`;

function windowOf(frames, from, to) {
  return frames.filter(frame => frame.t >= from && frame.t <= to);
}

function gapStats(frames) {
  let max = 0;
  let over50 = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const gap = frames[index].t - frames[index - 1].t;
    max = Math.max(max, gap);
    if (gap > 50) over50 += 1;
  }
  return {max, over50};
}

function analyze(record) {
  const frames = record.trace;
  const events = record.events;
  const begin = record.beginMs;
  const rel = absolute => absolute - begin;
  const marks = name => events.filter(event => event.what === name || event.what.startsWith(name));
  const touchDowns = marks('touch-down').map(event => event.t);
  const firstTouch = touchDowns.length > 0 ? touchDowns[0] : 6000;
  const scrollLog = (record.scrollLog || []).map(entry => ({...entry, t: rel(entry.t)}));
  const scrolls = scrollLog.filter(entry => entry.k === 's');
  const chases = scrollLog.filter(entry => entry.k === 'c');
  const haptics = record.haptics || [];
  const out = {tag: record.tag, frames: frames.length, durationMs: record.durationMs, hapticProbe: record.hapticProbe};
  out.gaps = gapStats(frames);

  // ---- 진입 ----
  const entryFrames = windowOf(frames, 0, firstTouch);
  const entryAnchor = both(entryFrames, f => f.anchor);
  const entryTail = both(entryFrames, f => f.tail);
  const entryContent = both(entryFrames, f => f.content);
  let settleAt = 0;
  for (let index = 1; index < entryFrames.length; index += 1) {
    const a = entryFrames[index].anchor;
    const b = entryFrames[index - 1].anchor;
    if (num(a) && num(b) && Math.abs(a - b) > 0.5) settleAt = entryFrames[index].t;
  }
  const entryScrolls = scrolls.filter(entry => entry.t <= firstTouch);
  const programScrolls = entryScrolls.filter(entry => !entry.user);
  let pinEpisodes = 0;
  let lastProgramAt = -1e9;
  for (const entry of programScrolls) {
    if (entry.t - lastProgramAt > 250) pinEpisodes += 1;
    lastProgramAt = entry.t;
  }
  out.entry = {
    untilMs: firstTouch,
    settleAt,
    anchor: entryAnchor,
    tail: entryTail,
    content: entryContent,
    statusMarks: events.filter(event => event.what.startsWith('status-') && event.t <= firstTouch).map(event => `${event.what}@${event.t}`),
    chaseOn: chases.filter(entry => entry.on && entry.t <= firstTouch).length,
    chaseOff: chases.filter(entry => !entry.on && entry.t <= firstTouch).length,
    scrollEvents: entryScrolls.length,
    userScrollEvents: entryScrolls.filter(entry => entry.user).length,
    programScrollEvents: programScrolls.length,
    pinEpisodes,
    lastProgramScrollAt: programScrolls.length === 0 ? null : programScrolls[programScrolls.length - 1].t,
  };

  // ---- 누름 · 글자 창 ----
  const kind = (frameList, preFrame) => {
    const dockH = both(frameList, f => f.dockH);
    const comp = both(frameList, f => f.comp);
    const view = both(frameList, f => f.viewport);
    const anchor = both(frameList, f => f.anchor);
    // 틈 = 도크 윗면 − 목록 꼬리. 창 직전 값에서 얼마나 벗어났는가.
    const gapOf = f => (num(f.dock) && num(f.tail) ? f.dock - f.tail : null);
    const base = preFrame === undefined ? null : gapOf(preFrame);
    let worstDeficit = 0;
    let worstExcess = 0;
    for (const frame of frameList) {
      const gap = gapOf(frame);
      if (gap === null || base === null) continue;
      worstDeficit = Math.min(worstDeficit, gap - base);
      worstExcess = Math.max(worstExcess, gap - base);
    }
    const first = frameList[0];
    const last = frameList[frameList.length - 1];
    const growth = first && last && num(first.dockH) && num(last.dockH) ? round(last.dockH - first.dockH) : null;
    const moved = first && last && num(first.anchor) && num(last.anchor) ? round(last.anchor - first.anchor) : null;
    return {
      dockH,
      comp,
      view,
      anchor,
      growth,
      moved,
      // 입력창(도크) 성장분 = −이동 이어야 한다(성장하면 마지막 행이 그만큼 위로).
      growthMinusMove: growth === null || moved === null ? null : round(growth + moved),
      gapDeficit: round(worstDeficit),
      gapExcess: round(worstExcess),
    };
  };
  const pressFrom = firstTouch;
  const pressFrames = windowOf(frames, pressFrom, pressFrom + 1500);
  const pre = windowOf(frames, pressFrom - 100, pressFrom - 1).pop();
  out.press = kind(pressFrames, pre);
  out.keyboard = events.filter(event => event.what.startsWith('keyboard')).map(event => `${event.what}@${event.t}`);
  const charMarks = marks('chars-').filter(event => event.what !== 'chars-0');
  out.chars = charMarks.map(event => {
    const preChar = windowOf(frames, event.t - 200, event.t - 101).pop();
    return {mark: event.what, at: event.t, ...kind(windowOf(frames, event.t - 100, event.t + 700), preChar)};
  });

  // ---- 초 단위 ----
  const lastChar = charMarks.map(event => event.t).pop();
  const attachAt = haptics.length > 0 ? haptics[haptics.length - 1].t : record.durationMs; // 마지막 햅틱 = 보내기 누름(양성 대조)
  const steadyFrom = (lastChar === undefined ? firstTouch + 6000 : lastChar + 3000);
  const steadyTo = attachAt - 500;
  const steady = windowOf(frames, steadyFrom, steadyTo);
  const ticks = events.filter(event => event.what.startsWith('txt:') && event.t >= steadyFrom && event.t <= steadyTo);
  let tickMoved = 0;
  const movedTicks = [];
  for (const tick of ticks) {
    const win = windowOf(frames, tick.t - 16, tick.t + 120);
    const a = both(win, f => f.anchor);
    const b = both(win, f => f.barH);
    const d = both(win, f => f.dockH);
    const moved = a[1].moves > 0 || b[1].moves > 0 || d[1].moves > 0;
    if (moved) {
      tickMoved += 1;
      movedTicks.push({at: tick.t, text: tick.what.slice(4), anchorMoves: `${a[0].moves}/${a[1].moves}`, barHMoves: `${b[0].moves}/${b[1].moves}`, dockHMoves: `${d[0].moves}/${d[1].moves}`});
    }
  }
  // 활동 줄 높이가 바뀐 순간과 그때의 글.
  const barFlips = [];
  for (let index = 1; index < steady.length; index += 1) {
    const a = steady[index].barH;
    const b = steady[index - 1].barH;
    if (num(a) && num(b) && Math.abs(a - b) > 0.5) {
      const textMark = [...events].filter(event => event.what.startsWith('txt:') && event.t <= steady[index].t).pop();
      barFlips.push({at: steady[index].t, from: round(b), to: round(a), text: textMark ? textMark.what.slice(4) : null});
    }
  }
  out.steady = {
    fromMs: steadyFrom,
    toMs: steadyTo,
    frames: steady.length,
    anchor: both(steady, f => f.anchor),
    barH: both(steady, f => f.barH),
    dockH: both(steady, f => f.dockH),
    view: both(steady, f => f.viewport),
    ticks: ticks.length,
    ticksWithMovement: tickMoved,
    movedTicks: movedTicks.slice(0, 12),
    barFlips: barFlips.length,
    barFlipList: barFlips.slice(0, 12),
    barHValues: [...new Set(steady.filter(f => num(f.barH)).map(f => round(f.barH)))],
    scrollEvents: scrolls.filter(entry => entry.t >= steadyFrom && entry.t <= steadyTo).length,
  };

  // ---- 장면 전체의 조용한 구간(입력·자판 이벤트 둘레를 뺀 모든 시간) ----
  // 「초 단위 갱신만으로」 움직이는가를 첫 1분 전체에서 본다: 닿음 −0.2~+1.7s · 글자 −0.2~+0.9s · 자판 −0.2~+0.9s · 진입 앉은 때 +0.5s 까지는 뺀다.
  const zones = [[0, Math.max(settleAt, 0) + 500]];
  for (const t of touchDowns) zones.push([t - 200, t + 1700]);
  for (const event of charMarks) zones.push([event.t - 200, event.t + 900]);
  for (const event of events.filter(item => item.what.startsWith('keyboard'))) zones.push([event.t - 200, event.t + 900]);
  const quiet = time => !zones.some(([from, to]) => time >= from && time <= to);
  const sendCut = attachAt - 300;
  const quietFrames = frames.filter(frame => quiet(frame.t) && frame.t <= sendCut);
  const quietTicks = events.filter(event => event.what.startsWith('txt:') && quiet(event.t) && event.t <= sendCut);
  const quietMoved = [];
  for (const tick of quietTicks) {
    const win = windowOf(frames, tick.t - 16, tick.t + 120);
    const a = both(win, f => f.anchor);
    const b = both(win, f => f.barH);
    const d = both(win, f => f.dockH);
    if (a[1].moves > 0 || b[1].moves > 0 || d[1].moves > 0) {
      quietMoved.push({at: tick.t, text: tick.what.slice(4), anchorMoves: `${a[0].moves}/${a[1].moves}`, barHMoves: `${b[0].moves}/${b[1].moves}`, dockHMoves: `${d[0].moves}/${d[1].moves}`});
    }
  }
  // 조용한 프레임 사이의 이동은 프레임 이웃끼리만 비교한다(구간을 건너뛴 두 프레임의 차는 사건이 낳은 것이다).
  const adjacent = (pick, eps) => {
    let moves = 0;
    let travel = 0;
    let maxStep = 0;
    for (let index = 1; index < frames.length; index += 1) {
      const a = frames[index];
      const b = frames[index - 1];
      if (!(quiet(a.t) && quiet(b.t) && a.t <= sendCut)) continue;
      if (!(num(pick(a)) && num(pick(b)))) continue;
      const size = Math.abs(pick(a) - pick(b));
      if (size <= eps) continue;
      moves += 1;
      travel += size;
      maxStep = Math.max(maxStep, size);
    }
    return {moves, travel: round(travel), maxStep: round(maxStep)};
  };
  const quietBarFlips = [];
  for (let index = 1; index < frames.length; index += 1) {
    const a = frames[index];
    const b = frames[index - 1];
    if (!(quiet(a.t) && quiet(b.t) && a.t <= sendCut && num(a.barH) && num(b.barH))) continue;
    if (Math.abs(a.barH - b.barH) > 0.5) {
      const textMark = [...events].filter(event => event.what.startsWith('txt:') && event.t <= a.t).pop();
      quietBarFlips.push({at: a.t, from: round(b.barH), to: round(a.barH), text: textMark ? textMark.what.slice(4) : null});
    }
  }
  out.quiet = {
    frames: quietFrames.length,
    seconds: round(quietFrames.length / 60),
    ticks: quietTicks.length,
    ticksWithMovement: quietMoved.length,
    movedTicks: quietMoved.slice(0, 12),
    anchor: [adjacent(f => f.anchor, EPS[0]), adjacent(f => f.anchor, EPS[1])],
    barH: [adjacent(f => f.barH, EPS[0]), adjacent(f => f.barH, EPS[1])],
    dockH: [adjacent(f => f.dockH, EPS[0]), adjacent(f => f.dockH, EPS[1])],
    view: [adjacent(f => f.viewport, EPS[0]), adjacent(f => f.viewport, EPS[1])],
    barHValues: [...new Set(quietFrames.filter(f => num(f.barH)).map(f => round(f.barH)))],
    barFlips: quietBarFlips.length,
    barFlipList: quietBarFlips.slice(0, 16),
    scrollEvents: scrolls.filter(entry => quiet(entry.t) && entry.t <= sendCut && entry.t > settleAt + 500).length,
  };

  // ---- 알약 · 프로그램 스크롤 ----
  const dayFrames = frames.filter(frame => frame.day);
  let pillDuringProgram = 0;
  for (const frame of dayFrames) {
    const recent = [...scrolls].filter(entry => entry.t <= frame.t && frame.t - entry.t <= 100).pop();
    if (recent !== undefined && !recent.user) pillDuringProgram += 1;
  }
  out.pill = {frames: dayFrames.length, duringProgramScroll: pillDuringProgram};
  out.haptic = {total: haptics.length, list: haptics.map(entry => `${entry.kind}@${entry.t}`), beforeAttach: haptics.filter(entry => entry.t < attachAt - 1).length};
  return out;
}

const results = records.map(analyze);
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}
for (const r of results) {
  console.log(`\n### ${r.tag}  (${r.frames}f · ${r.durationMs}ms · rAF 최대 간격 ${r.gaps.max}ms · 50ms 초과 ${r.gaps.over50}회 · 햅틱 프로브 ${r.hapticProbe})`);
  const e = r.entry;
  console.log(
    `진입(0~${e.untilMs}ms): 앵커 이동 ${fmt(e.anchor, 'moves')}프레임 · 이동합 ${fmt(e.anchor, 'travel')} · 최대한걸음 ${fmt(e.anchor, 'maxStep')} · 반전 ${fmt(e.anchor, 'reversals')} · 앉은 때 ${e.settleAt}ms` +
      ` | 내용 높이 변화 ${fmt(e.content, 'moves')}회(범위 ${e.content[0].range})` +
      ` | status ${e.statusMarks.join(' ')} | chasingTail 뗌 ${e.chaseOn}·붙임 ${e.chaseOff} | 스크롤 보고 ${e.scrollEvents}(손가락 ${e.userScrollEvents}·목록 ${e.programScrollEvents}) · 꼬리 고정 묶음 ${e.pinEpisodes} · 마지막 목록 스크롤 ${e.lastProgramScrollAt}ms`,
  );
  const p = r.press;
  console.log(
    `누름(+1.5s): 도크 ${p.dockH[0].net}pt(범위 ${p.dockH[0].range}) · 입력창 ${p.comp[0].net}pt · 목록 높이 ${p.view[0].net}pt(변화 ${p.view[0].moves}회) · 앵커 이동 ${p.moved}pt(반전 ${fmt(p.anchor, 'reversals')}) · 성장+이동 ${p.growthMinusMove} · 틈 편차 ${p.gapDeficit}/${p.gapExcess} | 자판 ${r.keyboard.join(' ')}`,
  );
  for (const c of r.chars) {
    console.log(
      `글자 ${c.mark}@${c.at}: 도크 ${c.dockH[0].net}pt · 입력창 ${c.comp[0].net}pt · 목록 높이 ${c.view[0].net}pt · 앵커 이동 ${c.moved}pt(구간 ${fmt(c.anchor, 'moves')}·반전 ${fmt(c.anchor, 'reversals')}) · 성장+이동 ${c.growthMinusMove} · 틈 편차 ${c.gapDeficit}/${c.gapExcess}`,
    );
  }
  const s = r.steady;
  console.log(
    `초 단위(${s.fromMs}~${s.toMs}ms, ${s.frames}f): 앵커 이동 ${fmt(s.anchor, 'moves')}프레임(범위 ${s.anchor[0].range}·반전 ${fmt(s.anchor, 'reversals')}) · 활동 줄 높이 값 ${s.barHValues.join(',')} 변화 ${fmt(s.barH, 'moves')}회 · 도크 높이 변화 ${fmt(s.dockH, 'moves')}회 · 목록 높이 변화 ${fmt(s.view, 'moves')}회 · 글 바뀜 ${s.ticks}번 중 움직임 동반 ${s.ticksWithMovement}번 · 스크롤 보고 ${s.scrollEvents}`,
  );
  for (const flip of s.barFlipList) console.log(`   활동 줄 높이 ${flip.from}→${flip.to} @${flip.at}ms  「${flip.text}」`);
  for (const moved of s.movedTicks) console.log(`   글 바뀜 뒤 움직임 @${moved.at}ms 「${moved.text}」 앵커 ${moved.anchorMoves} 활동줄 ${moved.barHMoves} 도크 ${moved.dockHMoves}`);
  const q = r.quiet;
  console.log(
    `조용한 구간 전체(${q.seconds}s·${q.frames}f, 글 바뀜 ${q.ticks}번): 앵커 이동 ${q.anchor[0].moves}/${q.anchor[1].moves}프레임(이동합 ${q.anchor[0].travel}/${q.anchor[1].travel}·최대 ${q.anchor[0].maxStep}/${q.anchor[1].maxStep}) · 활동 줄 높이 값 ${q.barHValues.join(',')} 변화 ${q.barH[0].moves}/${q.barH[1].moves}회 · 도크 높이 변화 ${q.dockH[0].moves}/${q.dockH[1].moves}회 · 목록 높이 변화 ${q.view[0].moves}/${q.view[1].moves}회 · 글 바뀜 중 움직임 동반 ${q.ticksWithMovement}번 · 스크롤 보고 ${q.scrollEvents}`,
  );
  for (const flip of q.barFlipList) console.log(`   [조용한 구간] 활동 줄 높이 ${flip.from}→${flip.to} @${flip.at}ms  「${flip.text}」`);
  for (const moved of q.movedTicks) console.log(`   [조용한 구간] 글 바뀜 뒤 움직임 @${moved.at}ms 「${moved.text}」 앵커 ${moved.anchorMoves} 활동줄 ${moved.barHMoves} 도크 ${moved.dockHMoves}`);
  console.log(`알약 선 프레임 ${r.pill.frames} · 목록이 낸 스크롤 중 선 프레임 ${r.pill.duringProgramScroll} | 햅틱 ${r.haptic.total}회 (보내기 누름 전 ${r.haptic.beforeAttach}회 · 누름 자신 ${r.haptic.total - r.haptic.beforeAttach}회): ${r.haptic.list.join(' ')}`);
}
