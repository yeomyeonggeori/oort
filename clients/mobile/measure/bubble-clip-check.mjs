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
 *
 * 한 문단의 틀(text)과 그린 줄(lines)은 같은 key 로 짝지어 읽는다. 말풍선은 key 의 앞자리(`<n>.<블록>` 의 n)로 찾는다.
 *
 * 허용 오차 TOL 은 반 픽셀(0.5pt)보다 작은 값이면 안 된다: 네이티브는 틀을 픽셀 격자로 올림하므로 1/3pt 단위로 흔들린다.
 * 반대로 크게 잡으면 잘림을 가린다 — 0.5pt 는 한 글자(≈16pt)의 3% 라 눈에 보이는 잘림은 못 숨긴다.
 */
import fs from 'node:fs';
import http from 'node:http';

const TOL = 0.5;

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
  console.log(`RESULT: PASS — ${cases.length}칸 모두 A~H 통과`);
} else {
  console.error('usage: node measure/bubble-clip-check.mjs serve|check …');
  process.exit(2);
}
