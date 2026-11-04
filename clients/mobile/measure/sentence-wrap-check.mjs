#!/usr/bin/env node
/**
 * `measure/sentenceWrap.tsx` 가 낸 레코드를 읽어 **숫자로** 단정한다 (#5288).
 *
 *   node measure/sentence-wrap-check.mjs check <out.jsonl> [--clean a,b,…] [--min-cases N] [--list] [--quiet]
 *
 * (받는 쪽은 `bubble-clip-check.mjs serve` 를 그대로 쓴다 — 레코드를 한 줄씩 적을 뿐이라 표면을 가리지 않는다.)
 *
 * 한 칸 = 같은 글을 한 폭·한 전략으로 그린 것. 앱이 시뮬레이터에서 네이티브에게 실제로 받은 두 숫자를 맞댄다:
 *   layoutH  `onLayout` 높이   = Yoga 가 글 상자에 준 높이 → expected = round(layoutH / lineH) 줄 (잰 줄 수)
 *   n        `onTextLayout`    = 최종 틀로 TextKit 이 낸 줄 수 (그릴 줄 수)
 *
 *   A  어긋남   n ≠ expected                      잰 줄 수와 그린 줄 수가 다르다 — 상자는 N 줄 높이인데 글은 M 줄로 그려진다
 *   B  넘침     maxRight > layoutW + 0.5           그린 줄이 글 상자 오른쪽을 넘는다
 *   C  고아     한글 글에서 둘 이상의 줄 중 마지막 줄이 한글 한 글자뿐   (어절 줄바꿈이 지키려는 것)
 *   E  빈 보고  틀(layoutH)·줄(n)이 없는 칸은 통과가 아니라 실패다 — **못 잰 것은 통과가 아니다**
 *   S  깎임     shave > 1e-4  글 상자 높이가 줄 수가 요구하는 높이(줄 수 × 줄 높이)보다 낮다. 네이티브가 준 높이가 float32 반올림으로
 *              1e-4pt 단위 깎인 것이다(위쪽 절대 y 가 클수록 커진다). A 의 원인 후보라서 A 와 겹치는 칸 수를 함께 센다.
 *
 * `--clean a,b` 로 준 전략은 A·B·E 위반이 하나라도 있으면 종료 코드 1이다(고친 뒤의 회귀 단정). 주지 않으면 표만 찍고 0 이다.
 * `--no-orphans a,b` 로 준 전략은 C(고아 줄)도 위반으로 센다.
 * 마지막에 `done` 기록이 없으면(앱이 끝까지 못 돌았다) 실패다.
 */
import fs from 'node:fs';

const [, , mode, file, ...flags] = process.argv;
if (mode !== 'check' || !file) {
  console.error('usage: node measure/sentence-wrap-check.mjs check <out.jsonl> [--clean a,b] [--no-orphans a,b] [--min-cases N] [--list] [--by-base] [--by-y] [--quiet]');
  process.exit(2);
}

function flagValue(name) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
}

const clean = (flagValue('--clean') ?? '').split(',').filter(Boolean);
const noOrphans = (flagValue('--no-orphans') ?? '').split(',').filter(Boolean);
const minCases = Number(flagValue('--min-cases') ?? 1);
const list = flags.includes('--list');
const quiet = flags.includes('--quiet');
const TOL = 0.5;
// 이 하네스의 한글 판별은 앱 쪽 구현과 일부러 따로 쓴다(공유하면 앱의 판별이 틀려도 같이 틀린다).
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

const records = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(line => JSON.parse(line));
// 다른 표면·도구가 같은 받는 쪽으로 보낸 기록은 세지 않는다(예: 임시 프로브).
const cases = records.filter(r => r.kind === 'case' && r.surface === 'sentence-wrap');
const done = records.find(r => r.kind === 'done' && r.surface === 'sentence-wrap');

/** 글 상자 높이가 줄 수와 무관한 진단 전략 — 높이에서 잰 줄 수를 구할 수 없어 A·B 를 세지 않는다(E 는 센다). */
const DIAGNOSTIC = new Set(['slack']);

function verdict(c) {
  const why = [];
  if (c.layoutH == null || c.n == null || c.n === 0 || c.expected == null) {
    why.push('E');
    return why;
  }
  if (DIAGNOSTIC.has(c.strategy)) return why;
  if (c.n !== c.expected) why.push('A');
  if (c.maxRight != null && c.layoutW != null && c.maxRight > c.layoutW + TOL) why.push('B');
  return why;
}

function orphan(c) {
  if (!Array.isArray(c.lines) || c.lines.length < 2) return false;
  const full = c.lines.map(l => l.t).join('');
  if (!HANGUL.test(full)) return false;
  const last = c.lines[c.lines.length - 1].t.trim();
  return [...last].length === 1 && HANGUL.test(last);
}

const byStrategy = new Map();
for (const c of cases) {
  const entry = byStrategy.get(c.strategy) ?? {total: 0, a: 0, b: 0, e: 0, s: 0, aAndS: 0, orphans: 0, hangulCases: 0, bad: []};
  entry.total += 1;
  const why = verdict(c);
  const shaved = typeof c.shave === 'number' && c.shave > 1e-4;
  if (shaved) entry.s += 1;
  if (why.includes('A') && shaved) entry.aAndS += 1;
  if (why.includes('A')) entry.a += 1;
  if (why.includes('B')) entry.b += 1;
  if (why.includes('E')) entry.e += 1;
  if (HANGUL.test(c.lines?.map(l => l.t).join('') ?? '')) entry.hangulCases += 1;
  if (orphan(c)) {
    entry.orphans += 1;
    if (noOrphans.includes(c.strategy)) why.push('C');
  }
  if (why.some(w => w !== 'C') || (why.includes('C') && noOrphans.includes(c.strategy))) entry.bad.push({c, why});
  byStrategy.set(c.strategy, entry);
}

if (!quiet) {
  console.log(`cases=${cases.length} done=${done ? `yes(total ${done.total}, bad ${done.bad})` : 'NO'} fontScale=${done?.fontScale ?? cases[0]?.fontScale ?? '?'}`);
  console.log('strategy      total  A:잰≠그림  B:넘침  E:빈  S:깎임  A∩S  C:고아(한글)');
  for (const [strategy, e] of byStrategy) {
    console.log(
      `${strategy.padEnd(12)} ${String(e.total).padStart(6)} ${String(e.a).padStart(10)} ${String(e.b).padStart(7)} ${String(e.e).padStart(5)} ${String(e.s).padStart(7)} ${String(e.aAndS).padStart(5)} ${String(e.orphans).padStart(6)}/${e.hangulCases}`,
    );
  }
  // 위쪽 절대 y(base)별로 A 와 S 를 맞대 본다 — 깎임이 절대 y 와 함께 커지는가.
  const byBase = new Map();
  for (const c of cases) {
    const key = `${c.strategy}|${c.base ?? 0}`;
    const e = byBase.get(key) ?? {total: 0, a: 0, s: 0};
    e.total += 1;
    if (verdict(c).includes('A')) e.a += 1;
    if (typeof c.shave === 'number' && c.shave > 1e-4) e.s += 1;
    byBase.set(key, e);
  }
  if (flags.includes('--by-y')) {
    // 같은 칸(글·폭·base·rep)이 전략마다 같은 절대 y 에 섰다면, 전략끼리 맞대 본다: 깎임(S)과 어긋남(A)이 전략과 상관있는가.
    const groups = new Map();
    for (const c of cases) {
      const key = `${c.id}|${c.W}|${c.base ?? 0}|${c.rep ?? 0}`;
      const g = groups.get(key) ?? [];
      g.push(c);
      groups.set(key, g);
    }
    let sameY = 0;
    let shavedSomewhere = 0;
    let strategyDiffers = 0;
    const examples = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const ys = new Set(g.map(c => c.wrapY));
      if (ys.size !== 1) continue; // 줄 수가 달라 y 가 어긋난 묶음은 맞댈 수 없다
      sameY += 1;
      const shaved = g.filter(c => typeof c.shave === 'number' && c.shave > 1e-4);
      if (shaved.length > 0) shavedSomewhere += 1;
      if (shaved.length > 0 && shaved.length < g.length) {
        strategyDiffers += 1;
        if (examples.length < 12) examples.push(g.map(c => `${c.strategy}:${c.shave > 1e-4 ? 'S' : '-'}${verdict(c).includes('A') ? 'A' : '-'}`).join(' ') + `  (y=${g[0].wrapY} ${g[0].id}@${g[0].W} base=${g[0].base} rep=${g[0].rep})`);
      }
    }
    console.log(`같은 y 에서 전략끼리 맞댄 묶음 ${sameY}개 · 어느 한 전략이라도 깎인 묶음 ${shavedSomewhere}개 · 그중 전략마다 달랐던 묶음 ${strategyDiffers}개`);
    for (const e of examples) console.log(`  ${e}`);
  }
  if (flags.includes('--by-base')) {
    console.log('strategy|base  total  A  S');
    for (const [key, e] of byBase) console.log(`${key.padEnd(24)} ${String(e.total).padStart(5)} ${String(e.a).padStart(3)} ${String(e.s).padStart(3)}`);
  }
  if (list) {
    for (const [strategy, e] of byStrategy) {
      for (const {c, why} of e.bad.slice(0, 60)) {
        console.log(
          `  ${why.join('')} ${strategy} ${c.id}@${c.W} base=${c.base ?? 0} y=${c.wrapY ?? '?'}: layoutH=${c.layoutH} (${c.expected}줄, shave ${c.shave}) drawn n=${c.n} maxRight=${c.maxRight} / layoutW=${c.layoutW} · ${JSON.stringify(c.lines?.map(l => l.t) ?? [])}`,
        );
      }
    }
  }
}

let failed = false;
const fail = message => {
  console.log(`FAIL ${message}`);
  failed = true;
};
if (cases.length < minCases) fail(`칸이 ${cases.length}개뿐이다(최소 ${minCases}) — 못 잰 것은 통과가 아니다`);
if (!done) fail('`done` 기록이 없다 — 앱이 끝까지 돌지 못했다');
for (const strategy of clean) {
  const e = byStrategy.get(strategy);
  if (!e) {
    fail(`--clean ${strategy}: 이 전략의 칸이 하나도 없다(빈 훑기)`);
    continue;
  }
  const violations = e.a + e.b + e.e;
  if (violations > 0) fail(`--clean ${strategy}: A ${e.a} · B ${e.b} · E ${e.e} (칸 ${e.total})`);
}
for (const strategy of noOrphans) {
  const e = byStrategy.get(strategy);
  if (e && e.orphans > 0) fail(`--no-orphans ${strategy}: 한 글자 고아 줄 ${e.orphans}개`);
}
if (!quiet) console.log(failed ? 'RESULT FAIL' : 'RESULT OK');
process.exit(failed ? 1 : 0);
