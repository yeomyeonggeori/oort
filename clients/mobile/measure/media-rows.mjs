#!/usr/bin/env node
/**
 * 대화 행의 세로 좌표를 시뮬레이터 녹화에서 시간별로 잰다 (#5451, #5456 폰 몫).
 *
 * 왜 영상인가: 큰 이모티콘·GIF·이미지·링크 카드가 섞인 **진짜 대화**(레인 서버 + 시드)에서 사람이 보는 움직임을 그대로 재려는 것이다.
 * 하네스 장면(`measure/steady.tsx`)은 가짜 서버·가짜 메시지라 미디어가 늦게 도착하는 길(받는 중 → 그림)을 못 만든다. 앱에 계측을 넣지도 않는다 —
 * 계측이 있으면 그 계측이 타이밍을 바꾼다.
 *
 * 행 하나 = 아바타 안의 글자(「S」 같은 머리글자)다. 아바타 칸(가로 16~56pt)만 잘라 어두운 잉크 덩어리를 찾고, 덩어리마다 세로 무게중심을
 * pt 로 낸다(3x 기기: 영상 3px = 1pt). 프레임마다 앞 프레임과 순서를 지켜 짝짓고(DP), 첫 목록 프레임에 보였던 행을 따라간다.
 * 한 사람이 연달아 쓴 글(아바타가 없는 이어진 글)은 행으로 세지 않는다 — 시드는 작성자를 번갈아 써서 모든 글에 아바타가 서게 한다.
 *
 * 사용:
 *   node measure/media-rows.mjs <녹화.mp4> --mode entry [--window 3] [--eps 1] [--json]
 *   node measure/media-rows.mjs <녹화.mp4> --mode taps --static <아래에서 N째 행> --gif <아래에서 N째 행> [--settle 3] [--eps 1] [--json]
 *
 * entry: 베일(행이 없는 프레임) 다음에 행이 둘 이상 선 첫 프레임(t0)부터 `window` 초 동안
 *   maxDev      t0 때 보이던 행이 그 자리에서 가장 멀리 벗어난 거리(pt)
 *   lastMoveMs  t0 자리에서 `eps` pt 넘게 벗어나 있던 마지막 시각(t0 기준 ms). 0 이면 흔들림 없음
 *   moves       앞 프레임 대비 0.5pt 넘게 움직인 행이 있던 프레임 수
 *   lost        따라가던 행이 사라진 수
 * taps: t0 + `settle` 초부터 끝까지(그 사이에 정지 이모티콘 누르기·GIF 누르기가 일어난다) 프레임마다
 *   rowMaxDevPt            행이 첫 자리에서 벗어난 거리의 최댓값 — 눌러서 줄이 움직이거나 스레드가 열리면 0 을 넘는다
 *   staticRowChangedFrames 정지 이모티콘 행의 그림이 기준 프레임과 달라진 프레임 수 — 눌러서 사라지거나 깜빡이면 0 을 넘는다
 *   gifBlankFrames         GIF 행의 그림 칸이 비어 보이는 프레임 수(기준 프레임의 잉크 면적의 절반 아래) — 누르면 사라지면 0 을 넘는다
 *   gifRowHeightPt         GIF 행 높이(그 행과 아래 행의 아바타 사이)의 [최소, 최대] — 움직임이 없으면 둘이 같다
 *
 * 종료 코드: 문턱 안이면 0, 넘으면 1, 읽지 못하면 2. 의존성: 시스템 ffmpeg·ffprobe 만.
 */
import {spawnSync} from 'node:child_process';

const argv = process.argv.slice(2);
const file = argv.find(arg => !arg.startsWith('--') && !/^-?\d+(\.\d+)?$/.test(arg));
const number = (name, fallback) => {
  const at = argv.indexOf(name);
  return at < 0 ? fallback : Number(argv[at + 1]);
};
const mode = argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'entry';
const EPS = number('--eps', 1);
if (!file || !['entry', 'taps'].includes(mode)) {
  console.error('usage: media-rows.mjs <video> --mode entry|taps [...]');
  process.exit(2);
}

const SCALE = 3; // 3x 기기: 1pt = 3px
const CX = 30, CW = 170; // 아바타 칸(px): 10~67pt
const CY = 390, CH = 1990; // 머리 유리 밑부터 입력 도크 위까지(px): 130~793pt
const INK = 110; // 이보다 어두우면 잉크
const FULL_W = 201, FULL_H = 437; // 전체 화면(2pt = 1px)

const run = (command, args) => {
  const result = spawnSync(command, args, {maxBuffer: 0x7fffffff});
  if (result.error || result.status !== 0) {
    console.error(`${command} 가 실패했다: ${String(result.stderr || result.error).slice(0, 300)}`);
    process.exit(2);
  }
  return result.stdout;
};
const probe = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
if (probe[0] !== 1206 || probe[1] !== 2622) console.error(`경고: 영상 크기 ${probe.join('x')} — 1206x2622(3x)를 가정해요`);
const pts = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file])
  .toString().split('\n').map(line => line.replace(',', '').trim()).filter(Boolean).map(Number);
const strip = run('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-vf', `crop=${CW}:${CH}:${CX}:${CY},format=gray`, '-f', 'rawvideo', '-']);
const full = mode === 'taps'
  ? run('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-vf', `scale=${FULL_W}:${FULL_H}:flags=area,format=gray`, '-f', 'rawvideo', '-'])
  : null;
const frameCount = Math.min(Math.floor(strip.length / (CW * CH)), full ? Math.floor(full.length / (FULL_W * FULL_H)) : Infinity, pts.length);

/** 한 프레임의 아바타 글자 덩어리(세로 무게중심, pt, 화면 맨 위 = 0). */
function blobs(buffer) {
  const rowInk = new Float32Array(CH);
  const rowMass = new Float32Array(CH);
  for (let y = 0; y < CH; y++) {
    let count = 0;
    let mass = 0;
    for (let x = 18; x < 138; x++) {
      const value = buffer[y * CW + x];
      if (value < INK) {
        count++;
        mass += INK - value;
      }
    }
    rowInk[y] = count;
    rowMass[y] = mass;
  }
  const out = [];
  let y = 0;
  while (y < CH) {
    if (rowInk[y] === 0) {
      y++;
      continue;
    }
    const first = y;
    let gap = 0;
    let last = y;
    while (y < CH && gap <= 6) {
      if (rowInk[y] > 0) {
        last = y;
        gap = 0;
      } else gap++;
      y++;
    }
    let total = 0;
    let weighted = 0;
    let ink = 0;
    for (let k = first; k <= last; k++) {
      total += rowMass[k];
      weighted += rowMass[k] * k;
      ink += rowInk[k];
    }
    // 아바타 글자: 높이 24~80px, 잉크 120px 이상
    if (last - first + 1 >= 24 && last - first + 1 <= 80 && ink >= 120) out.push((weighted / total + CY) / SCALE);
  }
  return out;
}

/** 순서를 지키는 짝짓기: a[i] ↔ b[j], 거리 ≤ 260pt, 짝 없음 벌점 70. */
function align(a, b) {
  const skip = 70;
  const reach = 260;
  const cost = Array.from({length: a.length + 1}, () => new Float64Array(b.length + 1));
  const from = Array.from({length: a.length + 1}, () => new Int8Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) {
    for (let j = 0; j <= b.length; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity;
      let via = 0;
      if (i > 0 && cost[i - 1][j] + skip < best) {
        best = cost[i - 1][j] + skip;
        via = 1;
      }
      if (j > 0 && cost[i][j - 1] + skip < best) {
        best = cost[i][j - 1] + skip;
        via = 2;
      }
      if (i > 0 && j > 0) {
        const distance = Math.abs(a[i - 1] - b[j - 1]);
        if (distance <= reach && cost[i - 1][j - 1] + distance < best) {
          best = cost[i - 1][j - 1] + distance;
          via = 3;
        }
      }
      cost[i][j] = best;
      from[i][j] = via;
    }
  }
  const pairs = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    const via = from[i][j];
    if (via === 3) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (via === 1) i--;
    else j--;
  }
  return pairs.reverse();
}

const series = [];
for (let f = 0; f < frameCount; f++) series.push({t: pts[f], ys: blobs(strip.subarray(f * CW * CH, (f + 1) * CW * CH))});
// t0: 대화의 베일(행이 없는 프레임들) 다음에 행이 둘 이상 선 첫 프레임 — 영상에 **마지막으로** 일어난 그런 전환이다. 앞에는 앱이 켜지는 화면과 채널 목록(아바타가 있는
// 다른 화면)이 찍혀 있을 수 있고, 그것들도 「행 없음 → 행 있음」으로 보이기 때문이다. 베일은 적어도 0.15초는 이어진다(한 프레임짜리 못 읽음은 베일이 아니다).
let start = -1;
let lastAny = -1;
for (let index = 1; index < series.length; index++) {
  if (series[index].ys.length < 2 || series[index - 1].ys.length >= 2) continue;
  let veilFrom = index - 1;
  while (veilFrom > 0 && series[veilFrom - 1].ys.length < 2) veilFrom--;
  if (series[index].t - series[veilFrom].t < 0.15) continue;
  lastAny = index;
  // 그 뒤로 행이 서 있는 프레임이 이어져야 한다(영상 끝에 찍힌 홈 화면·앱 종료 같은 잔상이 「마지막 전환」을 가로채지 못하게). 영상은 화면이 바뀔 때만 프레임을
  // 쓰므로(`simctl io recordVideo`) 가만히 선 대화는 시간이 아니라 **프레임 수**로 잰다: 8프레임 이상, 또는 영상 끝까지 이어진 3프레임 이상.
  let hold = index;
  while (hold + 1 < series.length && series[hold + 1].ys.length >= 2) hold++;
  const frames = hold - index + 1;
  if (frames >= 8 || (hold === series.length - 1 && frames >= 3)) start = index;
}
// 영상이 짧아 1초 이상 이어진 전환이 없으면 마지막 전환을 쓴다.
if (start < 0) start = lastAny;
if (start < 0) {
  console.log(JSON.stringify({error: '베일 뒤에 행이 보인 프레임이 없어요'}));
  process.exit(2);
}
const t0 = series[start].t;
const asJson = argv.includes('--json');
const rounded = value => Math.round(value * 10) / 10;

if (mode === 'entry') {
  const windowSeconds = number('--window', 3);
  const tracks = series[start].ys.map((y, id) => ({id, y0: y, alive: true}));
  let previous = series[start];
  let previousMap = new Map(series[start].ys.map((_, index) => [index, index]));
  let moves = 0;
  let lost = 0;
  let lastMove = 0;
  let maxDev = 0;
  const rows = [];
  for (let f = start; f < series.length; f++) {
    const current = series[f];
    const rel = (current.t - t0) * 1000;
    if (rel > windowSeconds * 1000) break;
    let currentMap = new Map(current.ys.map((_, index) => [index, index]));
    let frameMoved = false;
    if (f !== start) {
      currentMap = new Map();
      for (const [pi, ci] of align(previous.ys, current.ys)) {
        const id = previousMap.get(pi);
        if (id === undefined) continue;
        currentMap.set(ci, id);
        if (Math.abs(current.ys[ci] - previous.ys[pi]) > 0.5) frameMoved = true;
      }
      const alive = new Set(currentMap.values());
      for (const track of tracks) {
        if (track.alive && !alive.has(track.id)) {
          track.alive = false;
          lost++;
        }
      }
    }
    let frameDev = 0;
    for (const [ci, id] of currentMap) frameDev = Math.max(frameDev, Math.abs(current.ys[ci] - tracks[id].y0));
    if (frameMoved) moves++;
    maxDev = Math.max(maxDev, frameDev);
    if (frameDev > EPS) lastMove = rel;
    rows.push({t: Math.round(rel), rows: current.ys.length, dev: rounded(frameDev)});
    previous = current;
    previousMap = currentMap;
  }
  const summary = {
    file: file.split('/').pop(), mode, t0: Math.round(t0 * 1000) / 1000, tracked: tracks.length, windowSeconds,
    maxDev: rounded(maxDev), lastMoveMs: Math.round(lastMove), moves, lost, frames: rows.length,
  };
  console.log(JSON.stringify(asJson ? {summary, rows} : summary));
  process.exit(maxDev <= EPS ? 0 : 1);
}

// ---- taps ----
const staticFromBottom = number('--static', 2);
const gifFromBottom = number('--gif', 1);
const settle = number('--settle', 3);
const from = series.findIndex((entry, index) => index >= start && entry.t >= t0 + settle);
if (from < 0) {
  console.log(JSON.stringify({error: '시험 창이 비었어요(영상이 너무 짧아요)'}));
  process.exit(2);
}
const gray = (frame, x, y) => full[frame * FULL_W * FULL_H + y * FULL_W + x];
/** 아래에서 N째 행의 영역(2pt = 1px): 아바타 중심 − 14pt 부터 아래 행의 아바타 − 14pt 까지(맨 아래 행은 도크 위까지). */
function rowRegion(ys, fromBottom) {
  const sorted = [...ys].sort((a, b) => b - a);
  const y = sorted[fromBottom];
  if (y === undefined) return null;
  const below = fromBottom === 0 ? 790 + 14 : sorted[fromBottom - 1];
  return {y, top: Math.round((y - 14) / 2), bottom: Math.round((below - 14) / 2)};
}
/** 두 프레임의 행 영역(가로 70~250pt)을 위에서부터 맞춰 평균 절대 차이. 높이가 다르면 짧은 쪽까지. */
function regionDiff(frameA, regionA, frameB, regionB) {
  const height = Math.min(regionA.bottom - regionA.top, regionB.bottom - regionB.top);
  let sum = 0;
  let count = 0;
  for (let dy = 0; dy < height; dy++) {
    for (let x = 35; x < 125; x++) {
      sum += Math.abs(gray(frameA, x, regionA.top + dy) - gray(frameB, x, regionB.top + dy));
      count++;
    }
  }
  return count ? sum / count : 0;
}
/** GIF 그림 칸(아바타 아래 12pt 부터 150pt, 가로 75~215pt)에서 바탕(밝은 면)과 다른 점의 비율. */
function inkShare(frame, region) {
  const top = Math.round((region.y + 12) / 2);
  const bottom = Math.min(FULL_H - 1, Math.round((region.y + 12 + 150) / 2));
  let ink = 0;
  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = 37; x < 108; x++) {
      if (Math.abs(gray(frame, x, y) - 250) > 14) ink++;
      count++;
    }
  }
  return count ? ink / count : 0;
}
const reference = series[from];
const referenceStatic = rowRegion(reference.ys, staticFromBottom);
const referenceGif = rowRegion(reference.ys, gifFromBottom);
if (!referenceStatic || !referenceGif) {
  console.log(JSON.stringify({error: '기준 프레임에 행이 모자라요', rows: reference.ys.length}));
  process.exit(2);
}
const referenceInk = inkShare(from, referenceGif);
const referenceOrder = [...reference.ys].sort((a, b) => b - a);
let maxDev = 0;
let rowsLost = 0;
let staticChanged = 0;
let staticMax = 0;
let gifBlank = 0;
let gifMin = Infinity;
let gifMax = 0;
for (let f = from; f < frameCount; f++) {
  const current = series[f];
  const order = [...current.ys].sort((a, b) => b - a);
  if (order.length < referenceOrder.length) rowsLost++;
  for (let k = 0; k < Math.min(order.length, referenceOrder.length); k++) maxDev = Math.max(maxDev, Math.abs(order[k] - referenceOrder[k]));
  const staticRegion = rowRegion(current.ys, staticFromBottom);
  const gifRegion = rowRegion(current.ys, gifFromBottom);
  if (staticRegion) {
    const diff = regionDiff(from, referenceStatic, f, staticRegion);
    staticMax = Math.max(staticMax, diff);
    if (diff > 1.5) staticChanged++;
  }
  if (gifRegion) {
    if (inkShare(f, gifRegion) < referenceInk * 0.5) gifBlank++;
    const below = gifFromBottom === 0 ? 790 : order[gifFromBottom - 1];
    gifMin = Math.min(gifMin, below - gifRegion.y);
    gifMax = Math.max(gifMax, below - gifRegion.y);
  } else gifBlank++;
}
const result = {
  file: file.split('/').pop(), mode, t0: Math.round(t0 * 1000) / 1000, windowFrames: frameCount - from,
  rowMaxDevPt: rounded(maxDev), rowsLostFrames: rowsLost,
  staticRowChangedFrames: staticChanged, staticRowMaxDiff: Math.round(staticMax * 100) / 100,
  gifBlankFrames: gifBlank, gifRowHeightPt: [rounded(gifMin), rounded(gifMax)],
};
console.log(JSON.stringify(result));
const ok = maxDev <= EPS && rowsLost === 0 && staticChanged === 0 && gifBlank === 0 && gifMax - gifMin <= EPS;
process.exit(ok ? 0 : 1);
