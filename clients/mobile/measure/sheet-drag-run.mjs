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
  const flick = 100;
  const hx = Math.round((sheet.x0 + sheet.x1) / 2);
  const hy = sheet.y0 + 49; // 손잡이 띠 23 + 머리 줄 절반 26
  const env = {
    HX: hx,
    HY: hy,
    HY_SHORT: hy + short,
    HY_FAR: hy + far,
    HY_FLICK: hy + flick,
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
    Object.assign(env, {INPUTY: mid(input), INPUT_FAR: mid(input) + far});
  } else if (SURFACE === 'ACTION') {
    const reply = ids.get('sheet-reply');
    const gap = sheet.y0 + 23 + 52 + 6; // 머리 줄 바로 아래의 눌리지 않는 여백
    Object.assign(env, {ROWY: mid(reply), ROW_FAR: mid(reply) + far, GAPY: gap, GAP_FAR: gap + far});
  } else {
    const body = ids.get('sheetdrag-probe-body');
    const rowy = body.y0 + 40;
    Object.assign(env, {
      ROWY: rowy,
      DOWN_B: rowy + 120,
      UP_A: body.y1 - 120,
      UP_B: body.y1 - 120 - 400,
      BACK_A: body.y0 + 60,
      BACK_B: body.y0 + 360,
    });
  }
  return {env, geometry};
}

// ---- 녹화에서 시트 위 끝 ----------------------------------------------------

/**
 * 녹화의 한 열(왼쪽 가장자리 8pt — 무대의 카드는 16 부터라 그 열에는 무대 바탕과 시트 바탕뿐이다)을 프레임마다 읽어, 위에서 아래로 가장 센
 * 계단(시트 바탕이 시작하는 곳)을 시트 위 끝으로 본다. 그림자는 완만한 기울기라 계단이 이긴다. 모서리 반경 때문에 그 열의 위 끝은 직선보다
 * 조금 아래이지만 상수라 변위에는 영향이 없다. 시트가 화면 밖이면 `null`.
 */
function trackSheetTop(mp4, scale) {
  const probe = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', mp4]);
  const [w, h] = probe.stdout.trim().split('x').map(Number);
  const x = Math.round(8 * scale);
  const raw = sh(
    'ffmpeg',
    ['-v', 'error', '-i', mp4, '-vf', `fps=30,crop=1:${h}:${x}:0,format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    {encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024},
  ).stdout;
  const frames = Math.floor(raw.length / h);
  const rows = [];
  for (let f = 0; f < frames; f += 1) {
    const col = raw.subarray(f * h, (f + 1) * h);
    let best = 0;
    let bestAt = -1;
    for (let y = Math.round(40 * scale); y < h - 4; y += 1) {
      const g = Math.abs(col[y + 3] - col[y - 3]);
      if (g > best) {
        best = g;
        bestAt = y;
      }
    }
    rows.push({t: Math.round((f * 1000) / 30), top: best >= 10 ? Math.round((bestAt / scale) * 10) / 10 : null});
  }
  return {width: w, height: h, rows};
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

  const mp4 = path.join(OUT, `${TAG}.mp4`);
  let recorder = null;
  if (!args['no-record']) {
    fs.rmSync(mp4, {force: true});
    recorder = spawn('xcrun', ['simctl', 'io', UDID, 'recordVideo', '--codec=h264', '--force', mp4], {stdio: 'ignore'});
    await sleep(2000);
  }
  const envArgs = Object.entries(coords.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  envArgs.push('-e', `SHOT=${TAG}`);
  const flowPath = path.join(HERE, '..', 'maestro', FLOW);
  const startedAt = Date.now();
  // `takeScreenshot` 은 작업 디렉터리에 PNG 를 쓴다 — 출력 폴더에서 돌려 캡처가 한곳에 모이게 한다.
  const run = sh(MAESTRO, ['--udid', UDID, 'test', ...envArgs, '--debug-output', path.join(OUT, `${TAG}.maestro-debug`), flowPath], {
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
    const track = trackSheetTop(mp4, 3);
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
