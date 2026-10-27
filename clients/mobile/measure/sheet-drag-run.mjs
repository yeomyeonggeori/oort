#!/usr/bin/env node
/**
 * 시트 끌어내려 닫기의 시뮬레이터 구동 (#4612 2단계): 표면을 띄우고 → `maestro hierarchy` 로 시트의 기하를 읽어 좌표를 계산하고 →
 * 녹화를 켠 채 Maestro 흐름(`maestro/115~118-sheet-drag-*.yaml`)을 돌리고 → 녹화에서 시트 위 끝을 프레임마다 재서 한 줄 요약을 낸다.
 *
 * 왜 좌표를 읽는가: 시트의 위치는 기기(16 Pro·SE)·높이 단·키보드에 따라 다르다. 흐름의 `env:` 기본값은 16 Pro 의 큰 단이고, 이 스크립트가
 * 계층(`page-sheet` 의 경계)에서 머리 줄·문턱·눌리는 줄·빈 자리의 좌표를 새로 계산해 `-e` 로 덮어쓴다.
 *
 *   node clients/mobile/measure/sheet-drag-run.mjs \
 *     --udid <UDID> --device 16pro|se --surface LIST|EDIT|ACTION|PROBE-STD|PROBE-FREEZE|PROBE-NONE [--scheme dark|light] \
 *     --metro <Metro 포트> --out <폴더> [--sink-port-file F --sink-tag-file F --sink-jsonl F] [--no-record] [--settle 16]
 *
 *   싱크: `node clients/mobile/measure/gap-sink.mjs <out.jsonl> <port-file> <tag-file>` 를 먼저 띄운다(PROBE 표면은 필수).
 *
 * 출력(--out 아래): `<tag>.mp4`(녹화) · `<tag>.track.csv`(프레임마다 시트 위 끝 pt) · `<tag>.summary.json` · `<tag>.maestro.log`.
 */
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {trackSheetTop} from './sheet-drag-track.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAESTRO = path.join(process.env.HOME ?? '', '.maestro/bin/maestro');

const args = (() => {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
})();
for (const need of ['udid', 'device', 'surface', 'metro', 'out']) {
  if (!args[need]) {
    console.error(`usage: --${need} 가 필요하다 (머리말 참고)`);
    process.exit(2);
  }
}
const UDID = args.udid;
const SURFACE = String(args.surface).toUpperCase();
const SCHEME = args.scheme === 'light' ? 'light' : 'dark';
const TAG = `${args.device}-${SCHEME}-${SURFACE.toLowerCase()}`;
const OUT = path.resolve(args.out);
fs.mkdirSync(OUT, {recursive: true});
const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, {encoding: 'utf8', ...opts});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const FLOW = {
  LIST: '115-sheet-drag-list.yaml',
  EDIT: '116-sheet-drag-edit.yaml',
  ACTION: '117-sheet-drag-action.yaml',
  'PROBE-STD': '118-sheet-drag-probe.yaml',
  'PROBE-FREEZE': '118-sheet-drag-probe.yaml',
  'PROBE-NONE': '118-sheet-drag-probe.yaml',
}[SURFACE];
if (!FLOW) {
  console.error(`알 수 없는 표면: ${SURFACE}`);
  process.exit(2);
}

// ---- 계층 → 경계 -----------------------------------------------------------

function readHierarchy() {
  const r = sh(MAESTRO, ['--udid', UDID, 'hierarchy'], {maxBuffer: 64 * 1024 * 1024});
  const text = r.stdout;
  const start = text.indexOf('{');
  return start < 0 ? null : JSON.parse(text.slice(start));
}
/** `[x0,y0][x1,y1]` → {x0,y0,x1,y1}. */
const parseBounds = b => {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? '');
  return m ? {x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4]} : null;
};
function boundsById(tree) {
  const map = new Map();
  const walk = node => {
    const a = node.attributes ?? {};
    const id = a['resource-id'];
    const b = parseBounds(a.bounds);
    if (id && b && !map.has(id)) map.set(id, b);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return map;
}
const mid = b => Math.round((b.y0 + b.y1) / 2);

/** 시트 하나의 기하에서 흐름이 쓰는 좌표를 계산한다(pt). */
function coordinates(ids) {
  const sheet = ids.get('page-sheet');
  if (!sheet) throw new Error('계층에 page-sheet 가 없다 — 표면이 아직 안 섰다');
  const height = sheet.y1 - sheet.y0;
  const threshold = Math.max(64, height * 0.25);
  const far = Math.ceil(threshold * 1.5);
  const short = Math.floor(threshold * 0.3);
  // 빠른 튕김: 문턱 거리 **미만**(95% — 슬라이드 첫 6pt 는 흡수하므로 실제 변위는 95%-6pt)을 60ms 에 쓴다 — 거리로는 안 닫히고 속도 문턱(0.7px/ms)으로만 닫힌다. XCTest 합성 스와이프는 끝에서
  // 감속해 측정 속도가 명목 속도의 40~53% 라(실측: 100pt/60ms → 0.65, 150pt/100ms → 0.79, 200pt/100ms → 1.06), 명목 2.3px/ms 이상으로 쓴다.
  const flick = Math.floor(threshold * 0.95);
  const hx = Math.round((sheet.x0 + sheet.x1) / 2);
  const hy = sheet.y0 + 49; // 손잡이 띠 23 + 머리 줄 절반 26
  const env = {
    HX: hx,
    HY: hy,
    HY_SHORT: hy + short,
    HY_FAR: hy + far,
    HY_FLICK: hy + flick,
    FLICK_MS: 60,
    // 합성 스와이프는 요청 시간(35~60ms)과 무관하게 실제로 116~150ms 걸려서(실측: 78pt 튕김의 표본 간격) 속도가 거리/0.12s 쯤이다. 문턱 거리 아래에서
    // 속도 문턱(0.7px/ms)을 넘으려면 ≈100pt 이상이 필요해, 그보다 작은 시트(SE 편집 시트: 문턱 87pt → 튕김 78pt → 측정 0.52~0.63)에서는 이 장면을 못 쓴다.
    FLICK_SKIP: flick < 100,
  };
  const geometry = {sheetTop: sheet.y0, sheetHeight: height, thresholdPt: threshold, farPt: far, shortPt: short};
  if (SURFACE === 'LIST') {
    const row = ids.get('new-dm-person-member01');
    const pill = ids.get('new-dm-search-pill');
    const list = ids.get('new-dm-list');
    Object.assign(env, {
      ROWY: mid(row),
      ROW_FAR: mid(row) + far,
      BLANKY: pill.y0 - 14,
      BLANK_FAR: pill.y0 - 14 + far,
      BLANK_UP: Math.max(14, pill.y0 - 14 - 150),
      UP_A: hy + 60,
      UP_B: hy - 30,
      SCR_A: list.y1 - 100,
      SCR_B: list.y1 - 100 - 460,
      BACK_A: list.y0 + 160,
      BACK_B: list.y0 + 460,
      LONG_A: list.y0 + 120,
      LONG_B: list.y1 - 40,
    });
  } else if (SURFACE === 'EDIT') {
    const input = ids.get('editor-input');
    // BLANKY: 입력 상자 아래의 빈 본문(눌리지 않는 자리 — 시작 응답자 길). INPUTY: 입력 상자 위(입력이 응답자라 시트가 이동에서 가로채야 한다).
    Object.assign(env, {INPUTY: mid(input), INPUT_FAR: mid(input) + far, BLANKY: input.y1 + 40, BLANK_FAR: input.y1 + 40 + far});
  } else if (SURFACE === 'ACTION') {
    const reply = ids.get('sheet-reply');
    const gap = sheet.y0 + 23 + 52 + 6; // 머리 줄 바로 아래의 눌리지 않는 여백
    // SE(375×667)에서는 메시지 행동 시트가 최대 높이를 넘쳐 스크롤된다 — 넘치는 본문은 눌리지 않는 자리를 잡지 않는다(`claimsSheetTouchStart`).
    // 그 기기에서 장면 ④ 는 「안 닫힘」을 단정하고 뒤 장면의 닫힘 번호가 하나씩 당겨진다.
    const gapStays = args.device === 'se';
    Object.assign(env, {
      ROWY: mid(reply),
      ROW_FAR: mid(reply) + far,
      GAPY: gap,
      GAP_FAR: gap + far,
      GAP_STAYS: gapStays,
      N4: gapStays ? 3 : 4,
      N5: gapStays ? 4 : 5,
      N6: gapStays ? 5 : 6,
    });
  } else {
    const body = ids.get('sheetdrag-probe-body');
    // 짝수 줄(probe-row-2)은 누르는 줄, 홀수 줄(probe-row-5)은 눌리지 않는 줄이다(`measure/sheetDrag.tsx` `ProbeRows`).
    const pressy = mid(ids.get('probe-row-2'));
    const plainy = mid(ids.get('probe-row-5'));
    Object.assign(env, {
      ROWY: pressy,
      DOWN_B: pressy + 120,
      UP_A: plainy,
      UP_B: plainy - 300,
      BACK_A: body.y0 + 60,
      BACK_B: body.y0 + 360,
    });
  }
  return {env, geometry};
}

// ---- 흐름 틀 채우기 -----------------------------------------------------------

/**
 * Maestro 2.8 은 `swipe` 의 `start`·`end` 에 `${…}` 를 실행 시 파싱하지 못한다(`check-syntax` 는 통과해도 `Parsing Failed`).
 * 그래서 흐름 파일은 **틀**이고, 이 스크립트가 `env:` 의 기본값 위에 계산한 좌표를 얹어 `${이름}` 을 텍스트로 채운 파일을 만들어 돌린다.
 */
/**
 * 흐름 틀의 조건 블록. `# @skip-when NAME` … `# @end` 는 NAME 이 `true` 면 뺀다, `# @only-when NAME` … `# @end` 는 NAME 이 `true` 일 때만 넣는다.
 * (YAML 주석이라 틀을 그대로 열어도 문법은 유효하다.)
 */
function applyBlocks(text, values) {
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const open = /^#\s*@(skip-when|only-when)\s+([A-Z][A-Z0-9_]*)\s*$/.exec(line);
    if (open) {
      const on = values[open[2]] === 'true';
      skipping = open[1] === 'skip-when' ? on : !on;
      continue;
    }
    if (/^#\s*@end\s*$/.test(line)) {
      skipping = false;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function renderFlow(templatePath, overrides) {
  const text = fs.readFileSync(templatePath, 'utf8');
  const head = text.slice(0, text.indexOf('\n---'));
  const defaults = {};
  for (const m of head.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*"([^"]*)"/gm)) defaults[m[1]] = m[2];
  const values = {...defaults, ...Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, String(v)]))};
  const rendered = applyBlocks(text, values).replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (all, name) => {
    if (!(name in values)) throw new Error(`흐름 틀의 ${all} 에 값이 없다`);
    return values[name];
  });
  if (/\$\{[A-Z]/.test(rendered.slice(rendered.indexOf('\n---')))) throw new Error('채우지 못한 ${…} 가 남았다');
  return rendered;
}

// ---- 구동 ------------------------------------------------------------------

async function main() {
  const surfaceArg = `${SCHEME === 'light' ? 'LIGHT-' : ''}SHEETDRAG-${SURFACE}`;
  const settle = Number(args.settle ?? 16) * 1000;
  if (args['sink-tag-file']) fs.writeFileSync(args['sink-tag-file'], TAG);
  sh('xcrun', ['simctl', 'terminate', UDID, 'app.momo.ios']);
  await sleep(1000);
  const launchArgs = ['simctl', 'launch', UDID, 'app.momo.ios', '--args', '-momoMeasure', surfaceArg, '-RCT_jsLocation', `127.0.0.1:${args.metro}`];
  if (args['sink-port-file']) {
    launchArgs.push('-momoGapSink', `127.0.0.1:${fs.readFileSync(args['sink-port-file'], 'utf8').trim()}`);
  }
  sh('xcrun', launchArgs);
  await sleep(settle);

  let coords = null;
  for (let attempt = 0; attempt < 4 && !coords; attempt += 1) {
    const tree = readHierarchy();
    if (!tree) continue;
    try {
      coords = coordinates(boundsById(tree));
    } catch (error) {
      console.error(`[${TAG}] 기하를 못 읽었다(${attempt + 1}/4): ${error.message}`);
      await sleep(4000);
    }
  }
  if (!coords) process.exit(3);
  console.error(`[${TAG}] 기하 ${JSON.stringify(coords.geometry)}`);

  const flowPath = path.join(OUT, `${TAG}.flow.yaml`);
  fs.writeFileSync(flowPath, renderFlow(path.join(HERE, '..', 'maestro', FLOW), {...coords.env, SHOT: TAG}));
  if (args['render-only']) {
    console.log(flowPath);
    process.exit(0);
  }

  const mp4 = path.join(OUT, `${TAG}.mp4`);
  let recorder = null;
  if (!args['no-record']) {
    fs.rmSync(mp4, {force: true});
    recorder = spawn('xcrun', ['simctl', 'io', UDID, 'recordVideo', '--codec=h264', '--force', mp4], {stdio: 'ignore'});
    await sleep(2000);
  }
  const startedAt = Date.now();
  // `takeScreenshot` 은 작업 디렉터리에 PNG 를 쓴다 — 출력 폴더에서 돌려 캡처가 한곳에 모이게 한다.
  const run = sh(MAESTRO, ['--udid', UDID, 'test', '--debug-output', path.join(OUT, `${TAG}.maestro-debug`), flowPath], {
    maxBuffer: 64 * 1024 * 1024,
    cwd: OUT,
  });
  const log = `${run.stdout}\n${run.stderr}`;
  fs.writeFileSync(path.join(OUT, `${TAG}.maestro.log`), log);
  await sleep(1500);
  if (recorder) {
    recorder.kill('SIGINT');
    await new Promise(resolve => recorder.on('exit', resolve));
  }

  const summary = {tag: TAG, flow: FLOW, maestroExit: run.status, seconds: Math.round((Date.now() - startedAt) / 1000), ...coords};
  const lines = log.split('\n').filter(line => /COMPLETED|FAILED|Assert/.test(line));
  summary.commands = lines.length;
  summary.failed = lines.filter(line => /FAILED/.test(line));
  if (recorder && fs.existsSync(mp4)) {
    // 키보드가 있는 편집 시트는 시트 바닥(= 키보드 윗면) 위만 본다.
    const track = trackSheetTop(mp4, 3, SURFACE === 'EDIT' ? coords.geometry.sheetTop + coords.geometry.sheetHeight - 20 : Infinity);
    fs.writeFileSync(path.join(OUT, `${TAG}.track.csv`), ['t_ms,sheet_top_pt', ...track.rows.map(r => `${r.t},${r.top ?? ''}`)].join('\n'));
    const tops = track.rows.map(r => r.top).filter(v => v !== null);
    summary.track = {frames: track.rows.length, restTopPt: coords.geometry.sheetTop, minTopPt: Math.min(...tops), maxTopPt: Math.max(...tops)};
  }
  fs.writeFileSync(path.join(OUT, `${TAG}.summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  process.exit(run.status === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
