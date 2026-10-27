#!/usr/bin/env node
/**
 * `measure/activityRows.tsx`(`ACTIVITY-ROWS`)가 `-momoGapSink` 로 보낸 활동 줄 높이 표를 읽어, 이름 × 문구 변형마다
 * 「초(0…59)가 바뀔 때 줄 높이가 뒤집히는가」를 낸다 (#4613).
 *
 *   node measure/activity-rows.mjs <sink.jsonl> [--tag <태그>] [--prefix <태그 앞부분>] [--matrix] [--json]
 *   `--matrix`: 기록마다 한 줄 — 문구 변형별 「0…59초에서 높이가 뒤집힌 횟수」를 이름(짧은/중간/긴) 순으로 `a/b/c` 로.
 *   `--boundaries`: 기록마다 한 줄 — 높이가 뒤집힌 **어느 초 경계**인가(초별 변형 수)와 「59초 → 1분」 경계에서 뒤집힌 변형 수.
 *               9→10초(자릿수)·59초→1분(단위)·0→1초(「방금 들어왔어요」→「1초째」, 다른 문장) 경계가 각각 몇 변형에서 뒤집히는지 가른다.
 *
 * 한 줄의 읽는 법: `plain/short  56 ×60 | 분: 56 ×9` = 이 변형은 0…59초 모두 높이 56. 높이가 둘 이상이면 `56 ×22, 68 ×38 · 뒤집힘 11번 · 68: 2 3 5…` 처럼
 * 어느 초에서 몇 번 뒤집히는지와 큰 높이가 되는 초를 적는다. **뒤집힘이 0 이 아니면 그 문구는 초가 바뀔 때 화면이 움직일 수 있다.**
 * 의존성 없음.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--'));
const tagIndex = args.indexOf('--tag');
const wantTag = tagIndex === -1 ? null : args[tagIndex + 1];
const prefixIndex = args.indexOf('--prefix');
const wantPrefix = prefixIndex === -1 ? null : args[prefixIndex + 1];
const asMatrix = args.includes('--matrix');
const asWide = args.includes('--wide');
const asBoundaries = args.includes('--boundaries');
const asJson = args.includes('--json');
if (!file) {
  console.error('usage: node measure/activity-rows.mjs <sink.jsonl> [--tag <태그>] [--json]');
  process.exit(2);
}
const records = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '')
  .map(line => JSON.parse(line))
  .filter(record => record.scenario === 'rows' && (wantTag === null || record.tag === wantTag) && (wantPrefix === null || String(record.tag).startsWith(wantPrefix)));

const out = [];
for (const record of records) {
  const groups = new Map();
  for (const cell of record.table) {
    const key = `${cell.variant}/${cell.name}`;
    if (!groups.has(key)) groups.set(key, {seconds: [], minutes: []});
    const group = groups.get(key);
    if (cell.clock.endsWith('s')) group.seconds[Number(cell.clock.slice(0, -1))] = cell.height;
    else group.minutes[Number(cell.clock.slice(0, -1)) - 1] = cell.height;
  }
  const rows = [];
  for (const [key, group] of groups) {
    const counts = new Map();
    for (const height of group.seconds) counts.set(height, (counts.get(height) || 0) + 1);
    // 뒤집힘 = 줄 높이가 **0.5pt 넘게** 바뀐 초 경계(하네스의 이동 문턱과 같다). 0.1pt 안팎의 차이(`85.6`↔`85.7`)는 줄 수가 아니라 글리프 높이의 반올림이라
    // 화면에서 보이지도 움직이지도 않는다 — 세지 않고 `subpixel` 로 따로 센다.
    let flips = 0;
    let subpixel = 0;
    const flipSeconds = [];
    for (let index = 1; index < group.seconds.length; index += 1) {
      const delta = Math.abs(group.seconds[index] - group.seconds[index - 1]);
      if (delta > 0.5) {
        flips += 1;
        flipSeconds.push(index);
      } else if (delta > 0) subpixel += 1;
    }
    // 59초 표본에서 1분 표본으로 넘어갈 때(「59초째」→「1분째」) 높이가 뒤집히는가.
    const minuteBoundaryFlip = group.minutes.length > 0 && Math.abs(group.minutes[0] - group.seconds[group.seconds.length - 1]) > 0.5;
    const heights = [...counts.keys()].sort((a, b) => a - b);
    const biggest = heights[heights.length - 1];
    rows.push({
      key,
      heights: heights.map(height => `${height}×${counts.get(height)}`),
      flips,
      flipSeconds,
      minuteBoundaryFlip,
      subpixel,
      secondsAtBiggest: flips > 0 ? group.seconds.map((height, second) => (Math.abs(height - biggest) <= 0.5 ? second : null)).filter(second => second !== null) : [],
      minutes: group.minutes,
      secondsRun: group.seconds.join(','),
    });
  }
  out.push({tag: record.tag, width: record.width, fontScale: record.fontScale, rows});
}

if (asJson) {
  // `process.exit` 는 큰 출력을 파이프에서 자른다 — 정상 종료를 기다린다.
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = 0;
}
if (asBoundaries && !asJson) {
  for (const entry of out) {
    const flipping = entry.rows.filter(row => row.flips > 0);
    const bySecond = new Map();
    for (const row of entry.rows) for (const second of row.flipSeconds) bySecond.set(second, (bySecond.get(second) || 0) + 1);
    const seconds = [...bySecond.entries()].sort((a, b) => a[0] - b[0]).map(([second, count]) => `${second}초:${count}`).join(' ') || '없음';
    const minute = entry.rows.filter(row => row.minuteBoundaryFlip).length;
    console.log(
      `${String(entry.tag).padEnd(36)} ${String(entry.width).padStart(3)}pt ×${String(entry.fontScale).padEnd(5)} 변형 ${String(entry.rows.length).padStart(3)}개 | 뒤집힌 변형 ${String(flipping.length).padStart(3)} | 뒤집힌 초 경계(변형 수) ${seconds} | 59초→1분 경계 ${minute}`,
    );
  }
}
if (asWide && !asJson) {
  // `ACTIVITY-ROWS-WIDE`: 변형(생존 문구 × 앞에 m건) × 이름 마다 0…59초의 뒤집힘. 기록마다 요약 한 줄 + 뒤집히는 변형 목록.
  for (const entry of out) {
    const flipping = entry.rows.filter(row => row.flips > 0);
    const repeated = entry.rows.filter(row => row.flips > 2);
    const max = Math.max(0, ...entry.rows.map(row => row.flips));
    console.log(
      `${String(entry.tag).padEnd(36)} ${String(entry.width).padStart(3)}pt ×${String(entry.fontScale).padEnd(5)} 변형 ${entry.rows.length}개 중 뒤집힘 있음 ${flipping.length}개(3번 넘게 되풀이 ${repeated.length}개) · 최대 ${max}번`,
    );
    for (const row of repeated.slice(0, 12)) console.log(`   되풀이 ${row.key.padEnd(34)} ${row.flips}번 · ${row.heights.join(', ')}`);
    const sub = entry.rows.filter(row => row.subpixel > 0).length;
    console.log(`   (0.5pt 이하 높이 변화만 있는 변형 ${sub}개 — 세지 않음)`);
  }
}
if (asMatrix && !asJson) {
  const variants = ['plain', 'label', 'ahead2', 'label+ahead2'];
  const names = ['short', 'mid', 'long'];
  for (const entry of out) {
    const cell = (variant, name) => {
      const row = entry.rows.find(item => item.key === `${variant}/${name}`);
      return row === undefined ? '-' : String(row.flips);
    };
    const maxFlips = Math.max(...entry.rows.map(row => row.flips));
    const heights = Math.max(...entry.rows.map(row => row.heights.length));
    const columns = variants.map(variant => `${variant} ${names.map(name => cell(variant, name)).join('/')}`).join(' | ');
    console.log(`${String(entry.tag).padEnd(40)} ${String(entry.width).padStart(3)}pt ×${String(entry.fontScale).padEnd(5)} 최대 뒤집힘 ${String(maxFlips).padStart(2)}번 · 이 변형 | ${columns}`);
    void heights;
  }
}
if (!asJson && !asMatrix && !asWide && !asBoundaries) {
  for (const entry of out) {
    console.log(`\n### ${entry.tag}  폭 ${entry.width}pt · 글자 배율 ${entry.fontScale}`);
    for (const row of entry.rows) {
      const minutes = [...new Set(row.minutes)].join('/');
      const flip =
        row.flips === 0
          ? ''
          : ` · 뒤집힘 ${row.flips}번 · 큰 높이인 초: ${row.secondsAtBiggest.join(' ')}`;
      console.log(`${row.key.padEnd(22)} 초 ${row.heights.join(', ')}${flip} | 분(1~9): ${minutes}`);
    }
  }
}
