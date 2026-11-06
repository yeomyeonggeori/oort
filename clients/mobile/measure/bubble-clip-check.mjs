#!/usr/bin/env node
/**
 * `measure/bubbleClip.tsx` 의 받는 쪽과 단정 (#4894). 두 가지 일을 한다:
 *
 *   node measure/bubble-clip-check.mjs serve <out.jsonl> <port-file>
 *       POST /probe 로 오는 레코드를 한 줄씩 적는다. 임의 포트(0)로 열고 실제 포트를 <port-file> 에 쓴다 —
 *       앱 실행 인자 `-momoGapSink 127.0.0.1:<그 포트>` 에 넣는다. 의존성은 없다.
 *
 *   node measure/bubble-clip-check.mjs check <out.jsonl> [--min-cases N] [--quiet]
 *       적힌 레코드를 읽어 **숫자로** 단정한다. 하나라도 어기면 종료 코드 1.
 *
 *   node measure/bubble-clip-check.mjs stats <out.jsonl> [--set ko,mix,…]
 *   node measure/bubble-clip-check.mjs compare <before.jsonl> <after.jsonl> [--set ko,mix,…]
 *       (#5313) 줄바꿈 규칙을 바꿀 때 전후를 **숫자로** 맞댄다 — 단정이 아니라 표다(끝 코드는 0, `compare` 는 멈춤 기준을 어기면 3).
 *       한글 문단마다 센다: 줄 수 · 한 글자 고아 줄(마지막 줄이 한글 한 글자) · 낱말 가운데 꺾임(두 줄이 공백 없이 맞닿고 한쪽이 한글) ·
 *       줄 채움(마지막 줄을 뺀 줄 폭의 합 ÷ (줄 수−1)·글 상자 폭 — 낮을수록 줄 끝이 비어 말풍선 폭을 못 쓴 것) · 말풍선 폭 ÷ 본문 열.
 *       멈춤 기준(`compare`, 바꾸기 **전에** 정한 수): 한글 문단의 줄 수 합이 10% 넘게 늘거나, 한 칸이 2줄 넘게 늘거나, 줄 채움이 8%p 넘게 떨어지거나,
 *       A~I 위반 칸이 늘면 멈추고 숫자와 캡처로 보고한다.
 *
 * 단정은 앱이 시뮬레이터에서 네이티브에게 실제로 받은 틀이다(jest 는 Yoga·TextKit 이 없어 폭이 0 이라 못 잰다).
 *
 *   A  말풍선이 본문 열 안     bubble.w ≤ colW                         (말풍선마다)
 *   B  글 상자가 말풍선 안     text.w   ≤ bubble.w − 2·padX             (문단마다. 줄 보기 `row` 는 text.w ≤ colW)
 *   C  그려진 줄이 글 상자 안   lines.maxRight ≤ text.w                  (오른쪽에서 잘리지 않는다)
 *   D  마지막 줄이 글 상자 안   lines.bottom   ≤ text.h                  (아래에서 잘리지 않는다)
 *   E  잰 것이 있다           말풍선·글 상자·그린 줄 보고가 모두 있다 — **아무것도 못 잰 칸은 통과가 아니라 실패다**
 *   G  글이 보인다            글자가 있는 문단의 글 상자 폭이 4pt 이상이다  (목록 말풍선이 0pt 로 접히던 결함)
 *   H  말풍선이 글을 담는다    Σ(문단 높이) + 2·padY ≤ bubble.h            (말풍선이 안의 글보다 낮아 글이 밖으로 넘치던 결함 —
 *                                                                         문단 사이 간격은 더해질 뿐이라 이 합은 필요조건이다)
 *   I  줄이 빠지지 않는다      text.h − lines.bottom ≤ ½ · 줄 높이         (글 상자는 N 줄 높이인데 N−1 줄 이하로 그려진다 = 첫 줄이 줄바꿈 없이
 *                                                                         오른쪽에서 잘리고 둘째 줄이 빈다. 글 상자 높이가 float 반올림으로 줄 수의
 *                                                                         요구보다 1e-4pt 낮게 내려올 때 난다 — 절대 y 가 크고 1/3pt 소수일 때만이라
 *                                                                         `-momoClipBase`·`-momoClipReps` 로 훑어야 잡힌다. #5288·#4894)
 *
 * 한 문단의 틀(text)과 그린 줄(lines)은 같은 key 로 짝지어 읽는다. 말풍선은 key 의 앞자리(`<n>.<블록>` 의 n)로 찾는다.
 *
 * 허용 오차 TOL 은 반 픽셀(0.5pt)보다 작은 값이면 안 된다: 네이티브는 틀을 픽셀 격자로 올림하므로 1/3pt 단위로 흔들린다.
 * 반대로 크게 잡으면 잘림을 가린다 — 0.5pt 는 한 글자(≈16pt)의 3% 라 눈에 보이는 잘림은 못 숨긴다.
 */
import fs from 'node:fs';
import http from 'node:http';

const TOL = 0.5;

/** 한 칸의 위반 목록. 빈 배열이면 통과. */
function violations(c) {
  const out = [];
  if (!Array.isArray(c.paras) || c.paras.length === 0) {
    out.push('E 문단 보고가 하나도 없다');
    return out;
  }
  if (!c.row && (!Array.isArray(c.bubbles) || c.bubbles.length === 0)) {
    out.push('E 말풍선 보고가 없다');
    return out;
  }
  for (const b of c.bubbles ?? []) {
    const a = b.w - c.colW;
    if (a > TOL) out.push(`A 말풍선#${b.key} ${b.w} > 본문 열 ${c.colW} (+${a.toFixed(2)})`);
  }
  for (const p of c.paras) {
    if (!p.text || !p.lines || p.lines.n === 0 || p.lines.maxRight === null) {
      out.push(`E 문단 ${p.key}: 잰 것이 없다(text=${!!p.text} lines=${p.lines?.n ?? 0})`);
      continue;
    }
    const bubble = (c.bubbles ?? []).find(b => b.key === p.key.split('.')[0]);
    let limit;
    if (c.row) limit = c.colW;
    else if (!bubble) {
      out.push(`E 문단 ${p.key}: 앉은 말풍선 보고가 없다`);
      continue;
    } else limit = bubble.w - 2 * c.padX;
    const b = p.text.w - limit;
    const cc = p.lines.maxRight - p.text.w;
    const d = p.lines.bottom - p.text.h;
    if (b > TOL) out.push(`B 문단 ${p.key}: 글 상자 ${p.text.w} > ${c.row ? '본문 열' : '말풍선 안쪽'} ${limit} (+${b.toFixed(2)})`);
    if (cc > TOL) out.push(`C 문단 ${p.key}: 그린 줄 끝 ${p.lines.maxRight} > 글 상자 ${p.text.w} (+${cc.toFixed(2)})`);
    if (d > TOL) out.push(`D 문단 ${p.key}: 줄 아래끝 ${p.lines.bottom} > 글 상자 높이 ${p.text.h} (+${d.toFixed(2)})`);
    if (p.lines.chars > 0 && p.text.w < 4) out.push(`G 문단 ${p.key}: 글자 ${p.lines.chars}자인데 글 상자 폭이 ${p.text.w}pt — 안 보인다`);
    if (typeof p.lines.lineH === 'number' && p.lines.lineH > 0) {
      const missing = p.text.h - p.lines.bottom;
      if (missing > p.lines.lineH / 2) {
        out.push(`I 문단 ${p.key}: 글 상자 높이 ${p.text.h} 인데 그린 줄은 ${p.lines.n}줄(아래끝 ${p.lines.bottom}, 줄 높이 ${p.lines.lineH}) — ${(missing / p.lines.lineH).toFixed(1)}줄이 빠졌다`);
      }
    }
  }
  // H: 말풍선마다 안에 앉은 문단 높이의 합이 말풍선 안쪽 높이를 넘지 않는다. 줄 보기(row)에는 말풍선이 없다.
  if (!c.row) {
    for (const b of c.bubbles ?? []) {
      const inside = c.paras.filter(p => p.key.split('.')[0] === b.key && p.text);
      const sum = inside.reduce((acc, p) => acc + p.text.h, 0);
      const room = b.h - 2 * (c.padY ?? 0);
      if (sum > room + TOL) {
        out.push(`H 말풍선#${b.key}: 안의 문단 높이 합 ${sum.toFixed(1)} > 말풍선 안쪽 높이 ${room.toFixed(1)} (+${(sum - room).toFixed(1)}) — 글이 말풍선 밖으로 넘친다`);
      }
    }
  }
  return out;
}


const [, , mode, ...rest] = process.argv;

if (mode === 'serve') {
  const [outFile, portFile] = rest;
  if (!outFile || !portFile) {
    console.error('usage: node measure/bubble-clip-check.mjs serve <out.jsonl> <port-file>');
    process.exit(2);
  }
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
    });
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/probe') {
        let record;
        try {
          record = JSON.parse(raw);
        } catch (error) {
          record = {kind: 'unparsed', raw, parseError: String(error)};
        }
        fs.appendFileSync(outFile, `${JSON.stringify({at: new Date().toISOString(), ...record})}\n`);
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(portFile, String(server.address().port));
  });
} else if (mode === 'check') {
  const [file, ...flags] = rest;
  if (!file) {
    console.error('usage: node measure/bubble-clip-check.mjs check <out.jsonl> [--min-cases N] [--quiet]');
    process.exit(2);
  }
  const quiet = flags.includes('--quiet');
  const minIdx = flags.indexOf('--min-cases');
  const minCases = minIdx >= 0 ? Number(flags[minIdx + 1]) : 1;
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const cases = records.filter(r => r.kind === 'case');
  const done = records.filter(r => r.kind === 'done').at(-1);

  const failures = [];
  const byGroup = new Map();
  for (const c of cases) {
    const v = violations(c);
    const key = `${c.row ? 'row' : 'bubble'}/${c.who} W=${c.W} scale=${c.fontScale}`;
    const g = byGroup.get(key) ?? {n: 0, bad: 0};
    g.n += 1;
    if (v.length > 0) {
      g.bad += 1;
      failures.push({c, v});
    }
    byGroup.set(key, g);
  }

  console.log(`records=${records.length} cases=${cases.length} done=${done ? `total=${done.total} bad=${done.bad}` : 'MISSING'}`);
  for (const [key, g] of [...byGroup].sort()) {
    console.log(`${g.bad === 0 ? 'PASS' : 'FAIL'}  ${key.padEnd(44)} ${g.n - g.bad}/${g.n}`);
  }
  if (!quiet) {
    for (const {c, v} of failures.slice(0, 40)) {
      console.log(`  - ${c.id} @${c.W}: ${v.join(' | ')}`);
    }
    if (failures.length > 40) console.log(`  … 그 밖에 ${failures.length - 40}칸`);
  }

  const problems = [];
  if (cases.length < minCases) problems.push(`칸이 ${cases.length}개뿐이다(최소 ${minCases}) — 하네스가 다 못 돌았다`);
  if (!done) problems.push('끝 기록(done)이 없다 — 하네스가 중간에 멈췄다');
  else if (done.total !== cases.length) problems.push(`done.total ${done.total} ≠ 받은 칸 ${cases.length} — 기록이 샜다`);
  if (failures.length > 0) problems.push(`${failures.length}칸이 단정을 어겼다`);
  if (problems.length > 0) {
    console.log(`RESULT: FAIL — ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log(`RESULT: PASS — ${cases.length}칸 모두 A~I 통과`);
} else if (mode === 'stats' || mode === 'compare') {
  const need = mode === 'stats' ? 1 : 2;
  const files = rest.filter(arg => !arg.startsWith('--') && rest[rest.indexOf(arg) - 1] !== '--set').slice(0, need);
  if (files.length < need) {
    console.error(`usage: node measure/bubble-clip-check.mjs ${mode === 'stats' ? 'stats <out.jsonl>' : 'compare <before.jsonl> <after.jsonl>'} [--set ko,mix,…]`);
    process.exit(2);
  }
  const setIdx = rest.indexOf('--set');
  const sets = setIdx >= 0 ? rest[setIdx + 1].split(',').filter(Boolean) : null;
  // 이 도구의 한글 판별은 앱 쪽 구현과 일부러 따로 쓴다(공유하면 앱의 판별이 틀려도 같이 틀린다).
  const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

  const load = file =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
      .filter(r => r.kind === 'case' && (sets === null || sets.includes(r.set)));

  /** 한 칸의 한글 문단들을 센다. 줄 글(rows)이 없는 옛 기록은 세지 못하고 `unread` 로 센다 — 못 잰 것은 통과가 아니다. */
  function measureCase(c) {
    const out = {lines: 0, hangulLines: 0, multi: 0, orphans: 0, mid: 0, fillSum: 0, fillN: 0, bubbleRatio: null, unread: 0, violations: 0};
    const paras = c.paras ?? [];
    for (const p of paras) {
      out.lines += p.lines?.n ?? 0;
      const rows = p.lines?.rows;
      if (!Array.isArray(rows)) {
        out.unread += 1;
        continue;
      }
      const full = rows.map(r => r.t).join('');
      if (!HANGUL.test(full)) continue;
      out.hangulLines += rows.length;
      if (rows.length < 2) continue;
      out.multi += 1;
      const last = rows[rows.length - 1].t.trim();
      if ([...last].length === 1 && HANGUL.test(last)) out.orphans += 1;
      for (let i = 0; i + 1 < rows.length; i += 1) {
        const a = rows[i].t;
        const b = rows[i + 1].t;
        if (a === '' || b === '' || /\s$/.test(a) || /^\s/.test(b)) continue;
        if (HANGUL.test([...a].at(-1)) || HANGUL.test([...b][0])) out.mid += 1;
      }
      const width = p.text?.w ?? 0;
      if (width > 0) {
        const body = rows.slice(0, -1).reduce((acc, r) => acc + r.w, 0);
        out.fillSum += body / ((rows.length - 1) * width);
        out.fillN += 1;
      }
    }
    const bubble = (c.bubbles ?? [])[0];
    if (bubble && c.colW > 0 && out.multi > 0) out.bubbleRatio = bubble.w / c.colW;
    out.violations = violations(c).length;
    return out;
  }

  const keyOf = c => `${c.id}@${c.W}@${c.who}@${c.base ?? 0}@${c.rep ?? 0}`;
  const sum = (items, pick) => items.reduce((acc, item) => acc + pick(item), 0);

  function summarize(cases) {
    const m = cases.map(measureCase);
    const fillN = sum(m, x => x.fillN);
    const ratios = m.map(x => x.bubbleRatio).filter(x => x !== null);
    return {
      cases: cases.length,
      lines: sum(m, x => x.lines),
      hangulLines: sum(m, x => x.hangulLines),
      multi: sum(m, x => x.multi),
      orphans: sum(m, x => x.orphans),
      mid: sum(m, x => x.mid),
      fill: fillN === 0 ? null : sum(m, x => x.fillSum) / fillN,
      bubbleRatio: ratios.length === 0 ? null : ratios.reduce((a, b) => a + b, 0) / ratios.length,
      unread: sum(m, x => x.unread),
      violations: sum(m, x => x.violations),
      perCase: new Map(cases.map((c, i) => [keyOf(c), m[i]])),
    };
  }

  const pct = x => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
  const num = x => (x === null ? '-' : x.toFixed(3));

  const groups = new Map();
  const readSide = file => {
    const cases = load(file);
    const bySet = new Map();
    for (const c of cases) bySet.set(c.set, [...(bySet.get(c.set) ?? []), c]);
    groups.set(file, bySet);
    return {cases, bySet};
  };

  const header = '집합      칸   줄수합  한글줄  여러줄문단  고아  낱말꺾임  줄채움  말풍선/열  못읽음  A~I위반';
  const row = (label, s) =>
    `${label.padEnd(8)} ${String(s.cases).padStart(4)} ${String(s.lines).padStart(7)} ${String(s.hangulLines).padStart(7)} ${String(s.multi).padStart(10)} ${String(s.orphans).padStart(5)} ${String(s.mid).padStart(8)} ${pct(s.fill).padStart(7)} ${pct(s.bubbleRatio).padStart(9)} ${String(s.unread).padStart(6)} ${String(s.violations).padStart(7)}`;

  if (mode === 'stats') {
    const side = readSide(files[0]);
    console.log(header);
    for (const [set, cases] of [...side.bySet].sort()) console.log(row(set, summarize(cases)));
    console.log(row('전체', summarize(side.cases)));
    process.exit(0);
  }

  const before = readSide(files[0]);
  const after = readSide(files[1]);
  const sb = summarize(before.cases);
  const sa = summarize(after.cases);
  console.log('전  ' + header);
  for (const [set, cases] of [...before.bySet].sort()) console.log('    ' + row(set, summarize(cases)));
  console.log('    ' + row('전체', sb));
  console.log('후  ' + header);
  for (const [set, cases] of [...after.bySet].sort()) console.log('    ' + row(set, summarize(cases)));
  console.log('    ' + row('전체', sa));

  // 같은 칸끼리 맞댄다: 줄 수가 늘거나 줄어든 칸.
  let grew = 0;
  let grew2 = 0;
  let shrank = 0;
  let missing = 0;
  const worst = [];
  for (const [key, b] of sb.perCase) {
    const a = sa.perCase.get(key);
    if (!a) {
      missing += 1;
      continue;
    }
    const d = a.lines - b.lines;
    if (d > 0) grew += 1;
    if (d >= 2) {
      grew2 += 1;
      worst.push({key, d});
    }
    if (d < 0) shrank += 1;
  }
  console.log(`같은 칸 ${sb.perCase.size - missing}개 맞댐 · 줄 수가 늘어난 칸 ${grew} · 2줄 이상 늘어난 칸 ${grew2} · 줄어든 칸 ${shrank} · 한쪽에만 있는 칸 ${missing + (sa.perCase.size - (sb.perCase.size - missing))}`);
  for (const w of worst.slice(0, 8)) console.log(`  +${w.d}줄 ${w.key}`);

  const reasons = [];
  if (sb.hangulLines > 0 && sa.hangulLines / sb.hangulLines > 1.1) reasons.push(`한글 문단 줄 수 합 ${sb.hangulLines} → ${sa.hangulLines} (+${(((sa.hangulLines / sb.hangulLines) - 1) * 100).toFixed(1)}% > 10%)`);
  if (grew2 > 0) reasons.push(`한 칸이 2줄 이상 늘어난 칸 ${grew2}개`);
  if (sb.fill !== null && sa.fill !== null && sb.fill - sa.fill > 0.08) reasons.push(`줄 채움 ${pct(sb.fill)} → ${pct(sa.fill)} (${((sb.fill - sa.fill) * 100).toFixed(1)}%p > 8%p)`);
  if (sa.violations > sb.violations) reasons.push(`A~I 위반 칸 ${sb.violations} → ${sa.violations}`);
  if (sa.unread > 0 || sb.unread > 0) reasons.push(`줄 글이 없는 문단 ${sb.unread}/${sa.unread} — 못 잰 것은 통과가 아니다`);
  if (reasons.length > 0) {
    console.log(`STOP — ${reasons.join('; ')}`);
    process.exit(3);
  }
  console.log(`OK — 멈춤 기준 안: 한글 줄 수 ${sb.hangulLines} → ${sa.hangulLines}, 고아 ${sb.orphans} → ${sa.orphans}, 낱말꺾임 ${sb.mid} → ${sa.mid}, 줄 채움 ${pct(sb.fill)} → ${pct(sa.fill)}`);
} else {
  console.error('usage: node measure/bubble-clip-check.mjs serve|check|stats|compare …');
  process.exit(2);
}
