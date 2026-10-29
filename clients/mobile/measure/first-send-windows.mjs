#!/usr/bin/env node
/**
 * `measure/steady.tsx` 의 `enter` 장면(+ `measure/run-first-send.sh`)이 `-momoGapSink` 로 보낸 기록에서 **보내기 한 번마다** 앞 200ms ~ 뒤 3초를 잘라
 * 「보낼 때 대화가 몇 번 출렁이는가」를 숫자로 낸다 (#4749).
 *
 *   node measure/first-send-windows.mjs <sink.jsonl> [--tag <태그>] [--json] [--table] [--after <ms>]
 *
 * 보낸 때(S) = 앱 햅틱(`light`, 보내기 누름) 시각. 햅틱 계측이 없으면(`hapticProbe` 가 ok 아님) `draft-0-lines` 표식, 그것도 없으면 `sent` 표식.
 * 한 창에서 내는 것:
 *   - 맨 아래였던 행(`anchor` = 보내기 전 가장 새 말)의 y 이동: 움직인 프레임 수(0.5pt 문턱/0.01pt) · 이동량 합 · 가장 큰 한 걸음 · 방향 반전 · 범위 · 순이동
 *   - **출렁 횟수** = 이동 덩어리 수. 움직인 프레임을 100ms 이내로 이어 붙여 한 덩어리로 센다(= 사람 눈에 「한 번」). 덩어리마다 시작(ms)·길이·순이동.
 *   - 같은 창의 도크 윗면(`dock`)·도크 높이(`dockH`)·활동 줄 높이(`barH`)·입력창 높이(`comp`)·내용 길이(`content`)·스크롤 위치(`offset`) 변화와
 *     표식(`pending-add`·`sent`·`pending-remove`·키보드·`status-*`·`txt:`)·스크롤 보고(`s` 출처·`pin`)·`chasingTail` 전이(`c`)를 시간순으로 한 표에(`--table`).
 * 의존성 없음.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--tag' && args[args.indexOf(arg) - 1] !== '--after');
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? true);
};
if (!file) {
  console.error('usage: node measure/first-send-windows.mjs <sink.jsonl> [--tag <태그>] [--json] [--table] [--after <ms>]');
  process.exit(2);
}
const wantTag = flag('--tag');
const asJson = args.includes('--json');
const asTable = args.includes('--table');
const AFTER = Number(flag('--after') ?? 3000);
const BEFORE = 200;
const EPS = [0.5, 0.01];
const MERGE_MS = 100;

const records = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line))
  .filter(record => record.scenario === 'enter' && Array.isArray(record.trace) && (wantTag === null || record.tag === wantTag))
  .filter(record => Array.isArray(record.events) && record.events.some(event => String(event.what).startsWith('touch-down')));

const round = value => Math.round(value * 100) / 100;
const num = value => typeof value === 'number' && Number.isFinite(value);

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

/**
 * 목록 끝(`tail`)이 **아래로 내려앉은** 프레임들 — 내용이 자라 새 행이 아래로 밀린 때다(위로 올라오는 활강은 세지 않는다). 보내기 한 번에 정상은 1번(에코가 서는 때)이고,
 * 2번 이상이면 그 뒤의 것은 **이미 본 행이 다시 아래로 밀린 것**이다(= 사람이 느끼는 「출렁」, #4749). `delta` 는 그 프레임의 내려앉은 양(pt).
 */
function drops(frames, origin) {
  const list = [];
  for (let index = 1; index < frames.length; index += 1) {
    const a = frames[index].tail;
    const b = frames[index - 1].tail;
    if (!(num(a) && num(b))) continue;
    const delta = a - b;
    if (delta > EPS[0]) list.push({at: Math.round(frames[index].t - origin), delta: round(delta)});
  }
  return list;
}

/** 움직인 프레임을 MERGE_MS 이내로 이어 붙인 덩어리들. */
function episodes(frames, pick, eps, origin) {
  const list = [];
  let current = null;
  for (let index = 1; index < frames.length; index += 1) {
    const a = pick(frames[index]);
    const b = pick(frames[index - 1]);
    if (!(num(a) && num(b))) continue;
    const delta = a - b;
    if (Math.abs(delta) <= eps) continue;
    const t = frames[index].t;
    if (current !== null && t - current.endT <= MERGE_MS) {
      current.endT = t;
      current.net += delta;
      current.steps += 1;
      current.signs.add(delta > 0 ? 1 : -1);
    } else {
      current = {startT: t, endT: t, net: delta, steps: 1, signs: new Set([delta > 0 ? 1 : -1])};
      list.push(current);
    }
  }
  return list.map(item => ({at: Math.round(item.startT - origin), ms: Math.round(item.endT - item.startT), net: round(item.net), steps: item.steps, mixed: item.signs.size > 1}));
}

function analyze(record) {
  const frames = record.trace;
  const events = record.events;
  const begin = record.beginMs;
  const rel = absolute => absolute - begin;
  const scrollLog = (record.scrollLog || []).map(entry => ({...entry, t: rel(entry.t)}));
  const haptics = record.haptics || [];
  const probeOk = record.hapticProbe === 'ok';
  const drafts = events.filter(event => event.what === 'draft-0-lines').map(event => event.t);
  const sents = events.filter(event => event.what === 'sent').map(event => event.t);
  let submits = [];
  if (probeOk && haptics.length > 0) submits = haptics.map(entry => entry.t);
  else if (drafts.length > 0) submits = drafts;
  else submits = sents;
  const out = {tag: record.tag, frames: frames.length, durationMs: record.durationMs, hapticProbe: record.hapticProbe, submits: submits.map(Math.round), sends: []};
  const touchDowns = events.filter(event => String(event.what).startsWith('touch-down')).map(event => event.t);

  submits.forEach((submitAt, index) => {
    const nextSubmit = submits[index + 1];
    const to = Math.min(submitAt + AFTER, nextSubmit === undefined ? Infinity : nextSubmit - 200);
    const win = frames.filter(frame => frame.t >= submitAt - BEFORE && frame.t <= to);
    const after = win.filter(frame => frame.t >= submitAt - 16);
    const both = pick => EPS.map(eps => series(after, pick, eps));
    const send = {
      n: index + 1,
      submitAt: Math.round(submitAt),
      windowMs: Math.round(to - submitAt),
      anchor: both(f => f.anchor),
      dock: both(f => f.dock),
      dockH: both(f => f.dockH),
      barH: both(f => f.barH),
      comp: both(f => f.comp),
      content: both(f => f.content),
      offset: both(f => f.offset),
      drops: drops(win, submitAt),
      episodes: episodes(after, f => f.anchor, EPS[0], submitAt),
      episodesFine: episodes(after, f => f.anchor, EPS[1], submitAt),
      settledAt: null,
      marks: events
        .filter(event => event.t >= submitAt - BEFORE && event.t <= to && !String(event.what).startsWith('render-') && !String(event.what).startsWith('chars-') && !String(event.what).startsWith('draft-'))
        .map(event => `${Math.round(event.t - submitAt)}ms ${event.what}`),
      chase: scrollLog.filter(entry => entry.k === 'c' && entry.t >= submitAt - BEFORE && entry.t <= to).map(entry => `${Math.round(entry.t - submitAt)}ms ${entry.on ? 'on' : 'off'}`),
      scrolls: scrollLog.filter(entry => entry.k === 's' && entry.t >= submitAt - BEFORE && entry.t <= to).length,
      scrollsUser: scrollLog.filter(entry => entry.k === 's' && entry.user && entry.t >= submitAt - BEFORE && entry.t <= to).length,
      scrollsPin: scrollLog.filter(entry => entry.k === 's' && entry.pin && entry.t >= submitAt - BEFORE && entry.t <= to).length,
      touchNear: touchDowns.some(t => t >= submitAt - 100 && t <= to),
      beforeAfter: (() => {
        const first = after[0];
        const last = after[after.length - 1];
        const pick = key => (first && last && num(first[key]) && num(last[key]) ? [round(first[key]), round(last[key])] : null);
        return {anchor: pick('anchor'), dock: pick('dock'), dockH: pick('dockH'), barH: pick('barH'), comp: pick('comp'), content: pick('content'), offset: pick('offset'), rows: pick('rows'), pend: pick('pend')};
      })(),
    };
    const lastMove = send.episodes.length === 0 ? null : send.episodes[send.episodes.length - 1];
    send.settledAt = lastMove === null ? null : lastMove.at + lastMove.ms;
    if (asTable) {
      const table = [];
      const keys = ['anchor', 'tail', 'dock', 'dockH', 'barH', 'comp', 'content', 'offset', 'viewport', 'rows', 'pend'];
      for (let i = 1; i < win.length; i += 1) {
        const a = win[i];
        const b = win[i - 1];
        const changed = keys.filter(key => num(a[key]) && num(b[key]) && Math.abs(a[key] - b[key]) > 0.4);
        const here = events.filter(event => event.t > b.t && event.t <= a.t && !String(event.what).startsWith('render-') && !String(event.what).startsWith('chars-') && !String(event.what).startsWith('draft-')).map(event => event.what);
        const scrolled = scrollLog.filter(entry => entry.t > b.t && entry.t <= a.t).map(entry => (entry.k === 's' ? `s(y=${round(entry.y)},c=${round(entry.content)}${entry.user ? ',user' : ''}${entry.pin ? ',pin' : ''})` : `${entry.k}:${entry.on ? 'on' : 'off'}`));
        if (changed.length === 0 && here.length === 0 && scrolled.length === 0) continue;
        table.push(
          `${String(Math.round(a.t - submitAt)).padStart(6)}ms ` +
            changed.map(key => `${key}${a[key] - b[key] > 0 ? '+' : ''}${round(a[key] - b[key])}`).join(' ') +
            (here.length > 0 ? `  | ${here.join(', ')}` : '') +
            (scrolled.length > 0 ? `  | ${scrolled.join(', ')}` : ''),
        );
      }
      send.table = table;
    }
    out.sends.push(send);
  });
  return out;
}

const results = records.map(analyze);
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    console.log(`== ${result.tag} — frames ${result.frames}, hapticProbe ${result.hapticProbe}, 보낸 때(ms) ${result.submits.join(', ')}`);
    for (const send of result.sends) {
      const pair = (list, key) => `${list[0][key]}/${list[1][key]}`;
      const episodeText = send.episodes.length === 0 ? '없음' : send.episodes.map(item => `${item.at}ms+${item.ms}ms(${item.net}pt,${item.steps}걸음${item.mixed ? ',양방향' : ''})`).join(' · ');
      console.log(
        `  보내기 ${send.n} @${send.submitAt}ms (창 ${send.windowMs}ms)\n` +
          `    맨 아래였던 행: 이동 ${pair(send.anchor, 'moves')}프레임 · 합 ${pair(send.anchor, 'travel')}pt · 최대걸음 ${pair(send.anchor, 'maxStep')}pt · 반전 ${pair(send.anchor, 'reversals')} · 순이동 ${send.anchor[0].net}pt\n` +
          `    **내려앉음(목록 끝이 아래로 밀린 횟수)**: ${send.drops.length} → ${send.drops.map(item => `@${item.at}ms +${item.delta}pt`).join(' · ') || '없음'}\n` +
          `    이동 덩어리(0.5pt, 100ms 이음): ${send.episodes.length} → ${episodeText}\n` +
          `    이동 덩어리(0.01pt): ${send.episodesFine.length}\n` +
          `    도크 윗면 이동 ${pair(send.dock, 'moves')}프레임(순 ${send.dock[0].net}) · 도크 높이 ${pair(send.dockH, 'moves')}(순 ${send.dockH[0].net}) · 활동 줄 ${pair(send.barH, 'moves')}(순 ${send.barH[0].net}) · 입력창 ${pair(send.comp, 'moves')}(순 ${send.comp[0].net}) · 내용 ${pair(send.content, 'moves')}(순 ${send.content[0].net}) · 스크롤 위치 ${pair(send.offset, 'moves')}(순 ${send.offset[0].net})\n` +
          `    스크롤 보고 ${send.scrolls}(손가락 ${send.scrollsUser}, pin ${send.scrollsPin}) · 꼬리붙잡기 전이 ${send.chase.length === 0 ? '없음' : send.chase.join(', ')} · 표식 ${send.marks.join(' | ')}`,
      );
      if (send.table) {
        console.log('    -- 프레임 표(변한 칸만) --');
        for (const line of send.table) console.log(`    ${line}`);
      }
    }
  }
}
