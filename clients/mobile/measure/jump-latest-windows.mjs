#!/usr/bin/env node
/**
 * `measure/jumpLatest.tsx`(`JUMP-LATEST[+n120|+n300|+paged|+arrive|…]`, 흐름 `maestro/119-jump-latest.yaml`)가 `-momoGapSink` 로 보낸 시험 기록을
 * 시험마다 한 줄로 요약한다 — 「멀리 올라간 채 아래 알약(최신으로)을 누르면 마지막 메시지가 보이기까지 얼마나 걸리고 몇 번에 나눠 내려가는가」 (#4689).
 *
 *   node measure/jump-latest-windows.mjs <sink.jsonl> [--tag <태그>] [--json] [--detail] [--origin pill|touch]
 *
 *   --tag       그 태그의 기록만(없으면 태그마다 따로 표를 낸다).
 *   --json      표 대신 시험별 값과 거리별 중앙값을 JSON 으로.
 *   --detail    시험마다 **홉 목록**(누른 뒤 ms · 한 번의 이동량 · 그때 콘텐츠 높이)과 `chasingTail` 전이를 덧붙인다.
 *   --origin    「누름」의 기준 시각. `pill`(기본) = 알약이 사라지는 렌더(`pillsRef.latest` true→false) · `touch` = 래퍼의 `onTouchEnd`.
 *
 * 열(ms 는 누름 기준, 표본 간격이 프레임(≈16ms)이라 ±16ms 의 해상도다):
 *   dPt      누르기 전에 **목록이 스스로 안다고 한** 끝까지의 거리(pt). `travel` = 실제로 내려간 거리(착지 오프셋 − 누르기 전 오프셋) — 둘이 크게 다르면 목록의 끝(콘텐츠 높이)이 잘려 있었다.
 *   move     누름 → 첫 이동(스크롤 보고에서 오프셋이 누르기 전 값에서 >1pt 달라진 첫 순간)
 *   visible  누름 → 마지막 메시지 보임(그 행이 마운트돼 있고 **아랫변이 목록 창 안**(아래 가장자리 +2pt 까지)에 든 첫 프레임; `anchorRef.measureInWindow`)
 *            `stable` = 그 뒤로 다시는 안 사라지는 첫 순간, `full` = 윗변까지 창 안에 든 첫 순간
 *   land     누름 → 착지(끝까지 남은 거리 ≤1pt 가 600ms 이어지기 시작한 순간)
 *   hops     홉 수 — 아래 기준
 *   hops(fwd/rev)  홉 수(앞으로 간 홉 / 방향이 반대인 홉). paged 의 느림은 fwd 가 많은 것(꼬리가 잘려 한 배치씩 전진), full 의 흔들림은 rev 가 큰 것(해제 때 MVCP 가 앵커로 되밀음)이다.
 *   lastFwd 마지막 앞으로-홉의 시각(ms) · chaseOff `chasingTail` 이 꺼진(= `release`) 시각(ms) — 그 사이가 `holdLanding` 틱, 그 뒤가 `followGlide` 의 활강이다.
 *   step/gap 첫 홉(누르자마자 「지금 아는 끝」으로 가는 한 번)을 뺀 **앞으로 가는 홉**의 중앙값: 한 번에 전진하는 양(pt)과 홉 사이 간격(ms)
 *   anim     애니메이션 프레임 수 — 아래 기준
 *   content  콘텐츠 높이: 누를 때 → 착지 때(Δ = 자란 만큼). 자랐다면 끝이 움직이는 과녁이었다는 뜻이다.
 *   err      착지 오차 = 끝까지 남은 거리(pt, 착지 못 했으면 기록 끝에서)
 *   pill+600 착지(없으면 기록 끝) 600ms 뒤 `pillsRef.latest` — y 면 알약이 다시 섰다
 *   rebound  착지 뒤 최대 오프셋 되밀림(pt, ≤1 이면 0)
 *
 * 홉 = 누른 뒤 착지 전까지의 **손가락 아닌**(user:false) 스크롤 보고 가운데, 앞 보고(처음엔 누르기 전 오프셋)와의 오프셋 차가 >200pt 이거나 이동 방향이 앞 이동과 반대인 것.
 * 애니메이션 프레임 = 그 구간에서 홉이 아닌 보고 중 오프셋이 1~200pt 씩 움직인 것(활강 한 번이 이 값을 수십 개 만든다).
 * 의존성 없음.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index === -1 ? null : (args[index + 1] ?? true);
};
const file = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--tag' && args[args.indexOf(arg) - 1] !== '--origin');
if (!file) {
  console.error('usage: node measure/jump-latest-windows.mjs <sink.jsonl> [--tag T] [--json] [--detail] [--origin pill|touch]');
  process.exit(2);
}
const wantTag = flag('--tag');
const asJson = args.includes('--json');
const detail = args.includes('--detail');
const origin = flag('--origin') === 'touch' ? 'touch' : 'pill';

const HOP_PT = 200;
const LAND_PT = 1;
const LAND_MS = 600;
/** 끝에 앉은 마지막 행의 아랫변은 목록 창 아래 가장자리와 ±1pt 안에서 떤다(실측 0.3~0.7pt) — 그만큼은 「창 안」으로 본다. */
const VISIBLE_TOL_PT = 2;
const num = value => typeof value === 'number' && Number.isFinite(value);
const round = (value, digits = 1) => (num(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null);

const loaded = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(record => record !== null && record.scenario === 'jump-latest' && Array.isArray(record.trace) && (wantTag === null || record.tag === wantTag));

const median = values => {
  const list = values.filter(num).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
};

function analyze(rec) {
  const frames = rec.trace;
  const scrollAll = Array.isArray(rec.scrollLog) ? rec.scrollLog : [];
  const press = origin === 'touch' ? (rec.touchEndAt ?? rec.pressAt ?? rec.touchStartAt) : (rec.pressAt ?? rec.touchEndAt ?? rec.touchStartAt);
  const out = {
    tag: rec.tag,
    trial: rec.trial,
    label: rec.label,
    round: rec.round,
    room: rec.room,
    mode: rec.mode,
    arrive: rec.arrive === true,
    distancePt: rec.distancePt,
    targetSeq: rec.targetSeq,
    end: rec.end,
    pillGone: rec.pressAt != null,
  };
  if (!num(press)) return {...out, error: '눌리지 않음(no-press)'};
  const rel = t => (num(t) ? Math.round(t - press) : null);
  const box = rec.box;
  const post = frames.filter(frame => frame.t >= press - 50);
  const leftOf = frame => (num(frame.c) && num(frame.y) && num(frame.v) ? frame.c - (frame.y + frame.v) : null);

  // ---- 착지: 끝까지 ≤1pt 가 600ms 이어진 첫 구간의 시작 ------------------------------------
  let landStart = null;
  let landFrame = null;
  let run = null;
  for (const frame of post.filter(f => f.t >= press)) {
    const left = leftOf(frame);
    if (left !== null && Math.abs(left) <= LAND_PT) {
      if (run === null) run = frame;
      if (frame.t - run.t >= LAND_MS) {
        landStart = run.t;
        landFrame = run;
        break;
      }
    } else {
      run = null;
    }
  }
  const lastFrame = frames[frames.length - 1];
  const pressFrame = [...frames].reverse().find(frame => frame.t <= press) ?? frames[0];

  // ---- 스크롤 보고: 홉·애니메이션 프레임 ---------------------------------------------------
  const y0 = num(rec.atArm?.offsetY) ? rec.atArm.offsetY : pressFrame?.y;
  const travelEnd = landStart ?? Infinity;
  const scrolls = scrollAll.filter(entry => entry.k === 's' && entry.t >= press - 100);
  let prevY = y0;
  let lastDir = 0;
  let firstMove = null;
  let anim = 0;
  let animSpans = 0;
  let lastAnimAt = -1e9;
  let userReports = 0;
  const hops = [];
  for (const entry of scrolls) {
    if (entry.user) {
      userReports += 1;
      prevY = entry.y;
      continue;
    }
    const delta = entry.y - prevY;
    const size = Math.abs(delta);
    if (firstMove === null && size > 1) firstMove = entry.t;
    if (size <= 1) {
      prevY = entry.y;
      continue;
    }
    if (entry.t < travelEnd) {
      const dir = delta > 0 ? 1 : -1;
      const reversal = lastDir !== 0 && dir !== lastDir;
      if (size > HOP_PT || reversal) {
        hops.push({at: rel(entry.t), delta: round(delta), y: round(entry.y), content: round(entry.content), reversal});
      } else {
        anim += 1;
        if (entry.t - lastAnimAt > 50) animSpans += 1;
        lastAnimAt = entry.t;
      }
      lastDir = dir;
    }
    prevY = entry.y;
  }

  // ---- 마지막 메시지 보임 ------------------------------------------------------------------
  const seen = frame => box && num(frame.ab) && frame.ab <= box.bottom + VISIBLE_TOL_PT && frame.ab > box.top;
  const seenFull = frame => seen(frame) && num(frame.at) && frame.at >= box.top - 0.5;
  const after = frames.filter(frame => frame.t >= press);
  const firstSeen = after.find(seen);
  const firstFull = after.find(seenFull);
  let stable = null;
  for (let index = after.length - 1; index >= 0; index -= 1) {
    if (!seen(after[index])) {
      stable = after[index + 1] ?? null;
      break;
    }
    if (index === 0) stable = after[0];
  }
  if (stable !== null && !seen(stable)) stable = null;

  // ---- 콘텐츠·오차·알약·되밀림 -------------------------------------------------------------
  const endFrame = landFrame ?? lastFrame;
  const afterLand = landStart === null ? [] : frames.filter(frame => frame.t > landStart);
  let rebound = 0;
  if (landFrame !== null) {
    for (const frame of afterLand) if (num(frame.y)) rebound = Math.max(rebound, Math.abs(frame.y - landFrame.y));
  }
  const pillProbeAt = landStart === null ? null : landStart + LAND_MS;
  const pillFrame = pillProbeAt === null ? lastFrame : (frames.find(frame => frame.t >= pillProbeAt) ?? lastFrame);
  const contents = after.map(frame => frame.c).filter(num);
  const chases = scrollAll.filter(entry => entry.k === 'c' && entry.t >= press - 100).map(entry => ({at: rel(entry.t), on: entry.on}));

  // 첫 홉(누르자마자 「지금 아는 끝」으로 가는 한 번)을 빼고, 앞으로 가는 홉들의 크기·간격 — 홉마다 얼마씩 전진하는가.
  const forward = hops.filter(hop => !hop.reversal && hop.delta > 0);
  const rest = forward.slice(1);
  const hopSteps = rest.map(hop => hop.delta);
  const hopGaps = [];
  for (let index = 1; index < forward.length; index += 1) hopGaps.push(forward[index].at - forward[index - 1].at);

  return {
    ...out,
    // 실제로 내려간 거리(착지 오프셋 − 누르기 전 오프셋). `dPt`(= 누르기 전에 목록이 스스로 안다고 한 끝까지 거리)와 다르면 목록의 끝 추정이 잘려 있었다는 뜻이다.
    travelPt: num(endFrame?.y) && num(y0) ? round(endFrame.y - y0) : null,
    firstHopPt: forward.length > 0 ? forward[0].delta : null,
    hopStepPt: median(hopSteps),
    hopGapMs: median(hopGaps),
    pressVia: rec.pressAt != null && origin === 'pill' ? 'pill' : 'touch',
    touchToPill: num(rec.touchEndAt) && num(rec.pressAt) ? rec.pressAt - rec.touchEndAt : null,
    moveMs: firstMove === null ? null : rel(firstMove),
    visibleMs: firstSeen ? rel(firstSeen.t) : null,
    stableMs: stable ? rel(stable.t) : null,
    fullMs: firstFull ? rel(firstFull.t) : null,
    landMs: landStart === null ? null : rel(landStart),
    hops: hops.length,
    fwdHops: forward.length,
    revHops: hops.filter(hop => hop.reversal).length,
    lastFwdMs: forward.length > 0 ? forward[forward.length - 1].at : null,
    chaseOffMs: (chases.find(entry => entry.on === false && entry.at > 0) ?? {}).at ?? null,
    hopList: hops,
    anim,
    animSpans,
    userReports,
    contentPress: round(pressFrame?.c),
    contentLand: round(endFrame?.c),
    contentGrew: round((endFrame?.c ?? NaN) - (pressFrame?.c ?? NaN)),
    contentMax: round(contents.length === 0 ? NaN : Math.max(...contents)),
    landErr: round(leftOf(endFrame ?? {})),
    pillUp600: pillFrame?.pill === true,
    rebound: rebound > LAND_PT ? round(rebound) : 0,
    chases,
    durationMs: rel(lastFrame?.t),
    entryWaitMs: rec.entry?.waitedMs,
    entrySettled: rec.entry?.settled,
    ascentOk: rec.ascent?.ok,
    ascentMs: rec.ascent?.ms,
    skipped: Array.isArray(rec.skipped) ? rec.skipped : [],
    atArm: rec.atArm,
    frames: frames.length,
  };
}

const ORDER = ['near', '3scr', 'half', 'top'];
const text = (value, width, digits = 0) => {
  const shown = value === null || value === undefined ? '-' : typeof value === 'number' ? (digits === 0 ? String(Math.round(value)) : value.toFixed(digits)) : String(value);
  return shown.padStart(width);
};

const byTag = new Map();
for (const record of loaded) {
  const key = record.tag ?? '';
  if (!byTag.has(key)) byTag.set(key, []);
  byTag.get(key).push(record);
}

const result = [];
for (const [tag, records] of byTag) {
  const seenTrials = new Map();
  for (const record of records) seenTrials.set(record.trial, (seenTrials.get(record.trial) ?? 0) + 1);
  const dup = [...seenTrials].filter(([, count]) => count > 1).map(([trial]) => trial);
  const rows = records.map(analyze);
  const groups = new Map();
  // 올림이 목표에 못 닿았거나(시간 초과) 진입이 안 앉은 채 시작한 시험은 「그 거리」의 시험이 아니다 — 표에는 남기되(표식 !) 중앙값에서는 뺀다.
  const invalid = row => row.ascentOk === false || row.entrySettled === false;
  for (const row of rows) {
    if (row.error || invalid(row)) continue;
    const key = `${row.room}:${row.label}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const medians = [...groups]
    .map(([key, list]) => ({
      room: list[0].room,
      label: list[0].label,
      n: list.length,
      distancePt: median(list.map(row => row.distancePt)),
      travelPt: median(list.map(row => row.travelPt)),
      moveMs: median(list.map(row => row.moveMs)),
      visibleMs: median(list.map(row => row.visibleMs)),
      stableMs: median(list.map(row => row.stableMs)),
      landMs: median(list.map(row => row.landMs)),
      landed: list.filter(row => row.landMs !== null).length,
      hops: median(list.map(row => row.hops)),
      fwdHops: median(list.map(row => row.fwdHops)),
      revHops: median(list.map(row => row.revHops)),
      lastFwdMs: median(list.map(row => row.lastFwdMs)),
      chaseOffMs: median(list.map(row => row.chaseOffMs)),
      hopStepPt: median(list.map(row => row.hopStepPt)),
      hopGapMs: median(list.map(row => row.hopGapMs)),
      anim: median(list.map(row => row.anim)),
      contentPress: median(list.map(row => row.contentPress)),
      contentLand: median(list.map(row => row.contentLand)),
      contentGrew: median(list.map(row => row.contentGrew)),
      landErr: median(list.map(row => row.landErr)),
      absLandErr: median(list.map(row => (num(row.landErr) ? Math.abs(row.landErr) : null))),
      pillUp: list.filter(row => row.pillUp600).length,
      rebound: list.filter(row => row.rebound > 0).length,
    }))
    .sort((a, b) => ORDER.indexOf(a.label) - ORDER.indexOf(b.label));
  result.push({tag, dup, rows, medians});
}

if (asJson) {
  console.log(JSON.stringify(result.map(({rows, ...rest}) => ({...rest, rows: rows.map(({hopList, ...row}) => (detail ? {...row, hopList} : row))})), null, 2));
  process.exit(0);
}

console.log(
  `기준: 누름 = ${origin === 'pill' ? '알약이 사라지는 렌더(pillsRef.latest true→false)' : '래퍼 onTouchEnd'} · 홉 = 손가락 아닌 스크롤 보고 중 앞 보고와 >${HOP_PT}pt 차이거나 앞 이동과 방향이 반대인 것(착지 전까지) · 애니메이션 프레임 = 홉이 아닌 보고 중 1~${HOP_PT}pt 이동 · 착지 = 끝까지 ≤${LAND_PT}pt 가 ${LAND_MS}ms 이어짐 · 해상도 ≈16ms`,
);
for (const {tag, dup, rows, medians} of result) {
  console.log(`\n태그 ${tag || '(없음)'} — 기록 ${rows.length}건${dup.length > 0 ? ` · 경고: 같은 시험 번호가 겹침 ${dup.join(',')}(유령 기록일 수 있다)` : ''}`);
  console.log(
    ['#', 'dist', 'row', 'dPt', 'travel', 'move', 'visible', 'stable', 'full', 'land', 'hops', 'anim', 'content(press→land)', 'err', 'pill+600', 'rebound', 'end'].join('\t'),
  );
  for (const row of rows) {
    if (row.error) {
      console.log(`${text(row.trial, 2)}\t${row.label}\t${row.room}\t${text(row.distancePt, 7, 0)}\t${row.error}`);
      continue;
    }
    console.log(
      [
        text(row.trial, 2),
        row.label.padEnd(4),
        text(row.room, 3),
        text(row.distancePt, 7, 0),
        text(row.travelPt, 7, 0),
        text(row.moveMs, 5),
        text(row.visibleMs, 6),
        text(row.stableMs, 6),
        text(row.fullMs, 5),
        text(row.landMs, 5),
        text(row.hops, 3),
        text(row.anim, 3),
        `${text(row.contentPress, 7, 0)}→${text(row.contentLand, 7, 0)} (${row.contentGrew >= 0 ? '+' : ''}${text(row.contentGrew, 0, 0)})`,
        text(row.landErr, 6, 1),
        row.pillUp600 ? 'y' : 'n',
        text(row.rebound, 5, 1),
        row.end + (row.arrive ? '+arrive' : '') + (row.mode === 'paged' ? '+paged' : '') + (row.ascentOk === false ? ' !올림실패(중앙값 제외)' : '') + (row.entrySettled === false ? ' !진입미착(중앙값 제외)' : '') + (row.skipped.length > 0 ? ` ↻${row.skipped.length}(알약 안 선 시험을 버리고 다시 세움)` : ''),
      ].join('\t'),
    );
    if (detail) {
      const hopText = row.hopList.map(hop => `+${hop.at}ms ${hop.delta >= 0 ? '+' : ''}${hop.delta}pt${hop.reversal ? '(반전)' : ''} c=${hop.content}`).join(' | ');
      console.log(`    홉: ${hopText || '(없음)'}`);
      console.log(
        `    chasingTail: ${row.chases.map(c => `${c.at}ms ${c.on ? 'on' : 'off'}`).join(' → ') || '(전이 없음)'} · 애니메이션 구간 ${row.animSpans}개 · 손가락 보고 ${row.userReports} · 누름→알약 렌더 ${row.touchToPill ?? '-'}ms · 진입 ${row.entryWaitMs}ms(${row.entrySettled ? '앉음' : '못 앉음'}) · 올림 ${row.ascentMs}ms(${row.ascentOk ? 'ok' : '시간 초과'}) · 기록 ${row.durationMs}ms/${row.frames}프레임`,
      );
    }
  }
  console.log('\n거리별 중앙값');
  console.log(
    ['row', 'dist', 'n', 'dPt', 'travel', 'move', 'visible', 'stable', 'land', 'landed', 'hops(fwd/rev)', 'step(pt)', 'gap(ms)', 'lastFwd', 'chaseOff', 'anim', 'content press→land (Δ)', '|err|', 'pill+600', 'rebound'].join('\t'),
  );
  for (const m of medians) {
    console.log(
      [
        text(m.room, 3),
        m.label.padEnd(4),
        text(m.n, 2),
        text(m.distancePt, 7, 0),
        text(m.travelPt, 7, 0),
        text(m.moveMs, 5),
        text(m.visibleMs, 6),
        text(m.stableMs, 6),
        text(m.landMs, 5),
        `${m.landed}/${m.n}`,
        `${text(m.hops, 4, 1)}(${text(m.fwdHops, 0, 1)}/${text(m.revHops, 0, 1)})`,
        text(m.hopStepPt, 7, 0),
        text(m.hopGapMs, 6, 0),
        text(m.lastFwdMs, 6, 0),
        text(m.chaseOffMs, 6, 0),
        text(m.anim, 4, 1),
        `${text(m.contentPress, 7, 0)}→${text(m.contentLand, 7, 0)} (${m.contentGrew >= 0 ? '+' : ''}${text(m.contentGrew, 0, 0)})`,
        text(m.absLandErr, 6, 1),
        `${m.pillUp}/${m.n}`,
        `${m.rebound}/${m.n}`,
      ].join('\t'),
    );
  }
}
