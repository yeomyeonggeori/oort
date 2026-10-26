#!/usr/bin/env node
/**
 * 시뮬레이터 녹화에서 「한 프레임짜리 깜빡임」을 찾는다 (#4455 design-review r3 H3·r4).
 *
 * 레이아웃 지표(내용 높이·스크롤 offset·꼬리 - 도크)는 **크기와 자리가 같고 칠만 바뀌는** 사건을 못 본다 — 새로 마운트된 이미지 뷰의 첫
 * 프레임이 비어서 사진 타일이 한 프레임 중립 면으로 번쩍이는 것이 그 예다. 프레임 시트(약 60ms 간격 8칸)도 한 프레임짜리 사건은 칸 사이로
 * 빠진다. 이 도구는 영상의 **모든 프레임**을 읽어 「앞 프레임 = 뒤 프레임인데 가운데 한 장만 다른」 프레임을 센다.
 *
 *   node measure/blank-frame-detector.mjs <녹화.mov> [--width 215] [--threshold 8] [--min-pixels 800]
 *
 * 규칙(프레임 i 에 대해, n(a, b) = 두 프레임의 밝기 차이가 threshold 를 넘는 픽셀 수):
 *   n(i-1, i) > min-pixels  그리고  n(i, i+1) > min-pixels  그리고  n(i-1, i+1) < 0.15 × min(n(i-1, i), n(i, i+1))
 * 깜빡임이 0건이면 종료 코드 0, 하나라도 있으면 1 이다.
 *
 * 영상은 **화면이 바뀔 때만 프레임을 쓴다**(`simctl io recordVideo`) — 정지한 구간에는 프레임이 없으므로 「앞 정지 구간」이 길수록 그 깜빡임은
 * 움직임에 안 가려진 정지 화면에서 일어난 것이다. 출력의 `shown` 은 그 프레임이 화면에 있던 시간이다.
 *
 * 의존성: 시스템 `ffmpeg`·`ffprobe` 만(Node 모듈 없음). 프레임을 PNG 로 풀지 않고 흑백 원시 프레임으로 파이프에서 곧바로 읽는다.
 * 장면의 표식 시각(`-momoGapSink` 의 jsonl `events`)과 맞추는 일은 부르는 쪽 몫이다: 영상 시각 = 녹화 시작 시각 기준 + 표식 시각.
 */
import {spawnSync} from 'node:child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {maxBuffer: 0x7fffffff, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 가 실패했다(${result.status}): ${String(result.stderr).slice(0, 400)}`);
  }
  return result.stdout;
}

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('사용: node measure/blank-frame-detector.mjs <녹화.mov> [--width 215] [--threshold 8] [--min-pixels 800]');
  process.exit(2);
}
const width = option('--width', 215);
const threshold = option('--threshold', 8);
const minPixels = option('--min-pixels', 800);

const [sourceWidth, sourceHeight] = String(
  run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]),
)
  .trim()
  .split(',')
  .map(Number);
const height = 2 * Math.round((sourceHeight * width) / sourceWidth / 2); // `scale=W:-2` 와 같은 짝수 높이

const pts = String(
  run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file]),
)
  .split('\n')
  .map(line => line.replace(/,$/, '').trim())
  .filter(line => line !== '') // 끝의 빈 줄이 `Number('') === 0` 으로 프레임 하나를 더 세지 않게
  .map(Number)
  .filter(Number.isFinite)
  .sort((a, b) => a - b);

const raw = run('ffmpeg', [
  '-v', 'error', '-i', file,
  '-vf', `scale=${width}:-2,format=gray`,
  '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
]);
const frameSize = width * height;
const count = Math.floor(raw.length / frameSize);
if (count !== pts.length) {
  console.error(`프레임 수가 안 맞는다: 픽셀 ${count} 대 pts ${pts.length} (${file})`);
  process.exit(2);
}

/** 두 프레임에서 밝기가 threshold 넘게 다른 픽셀 수. */
function changed(a, b) {
  let total = 0;
  const offsetA = a * frameSize;
  const offsetB = b * frameSize;
  for (let index = 0; index < frameSize; index += 1) {
    if (Math.abs(raw[offsetA + index] - raw[offsetB + index]) > threshold) total += 1;
  }
  return total;
}

const adjacent = [];
for (let index = 0; index < count - 1; index += 1) adjacent.push(changed(index, index + 1));

const blips = [];
for (let index = 1; index < count - 1; index += 1) {
  const before = adjacent[index - 1];
  const after = adjacent[index];
  if (before > minPixels && after > minPixels && changed(index - 1, index + 1) < 0.15 * Math.min(before, after)) {
    blips.push({
      at: pts[index],
      shownMs: Math.round((pts[index + 1] - pts[index]) * 1000),
      stillBeforeMs: Math.round((pts[index] - pts[index - 1]) * 1000),
      before,
      after,
    });
  }
}

console.log(`${file}: frames=${count} (${width}x${height}) blips=${blips.length}`);
for (const blip of blips) {
  console.log(
    `  blip pts=${blip.at.toFixed(3)}s shown=${blip.shownMs}ms still-before=${blip.stillBeforeMs}ms changed(prev→blip)=${blip.before} changed(blip→next)=${blip.after}`,
  );
}
process.exit(blips.length === 0 ? 0 : 1);
