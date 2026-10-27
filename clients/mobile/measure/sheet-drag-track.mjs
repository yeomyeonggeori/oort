#!/usr/bin/env node
/**
 * 시뮬레이터 녹화에서 시트 위 끝의 높이(pt)를 프레임마다 잰다 (#4612 2단계). `sheet-drag-run.mjs` 가 쓰고, 단독으로도 돈다.
 *
 *   node clients/mobile/measure/sheet-drag-track.mjs <녹화.mp4> [배율 3] [검색 상한 y pt] [화면 폭 pt] > track.csv     (t_ms,sheet_top_pt)
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, {encoding: 'utf8', ...opts});


/**
 * 녹화의 한 열(왼쪽 가장자리 8pt — 무대의 카드는 16 부터라 그 열에는 무대 바탕과 시트 바탕뿐이다)을 프레임마다 읽어, 위에서 아래로 가장 센
 * 계단(시트 바탕이 시작하는 곳)을 시트 위 끝으로 본다. 그림자는 완만한 기울기라 계단이 이긴다. 모서리 반경 때문에 그 열의 위 끝은 직선보다
 * 조금 아래이지만 상수라 변위에는 영향이 없다. 시트가 화면 밖이면 `null`.
 */
export function trackSheetTop(mp4, scaleArg, maxYpt = Infinity, widthPt = null) {
  const probe = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', mp4]);
  const [w, h] = probe.stdout.trim().split('x').map(Number);
  // 배율은 기기마다 다르다(16 Pro 3x → 1206 폭, SE 2x → 750 폭). 화면 폭(pt)을 알면 영상 폭에서 구한다 — 3 으로 못 박으면 SE 의 변위·프레임이 틀린다
  // (design-review r1 M2: SE 수치가 실제의 2/3 였다). 모르면 호출자가 준 배율을 쓴다.
  const scale = widthPt ? w / widthPt : scaleArg;
  const x = Math.round(8 * scale);
  const raw = sh(
    'ffmpeg',
    // 색차 서브샘플링 때문에 폭 1 로는 못 자른다 — gray 로 바꾼 뒤 폭 2 로 자르고 첫 열만 읽는다.
    ['-v', 'error', '-i', mp4, '-vf', `fps=30,format=gray,crop=2:${h}:${x}:0`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    {encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024},
  ).stdout;
  const frames = Math.floor(raw.length / (2 * h));
  const rows = [];
  for (let f = 0; f < frames; f += 1) {
    const col = new Uint8Array(h);
    for (let y = 0; y < h; y += 1) col[y] = raw[f * 2 * h + y * 2];
    let best = 0;
    let bestAt = -1;
    // 키보드가 올라온 시트는 키보드 윗면이 더 센 계단이다 — 검색을 시트 안(`maxYpt` 위)으로 좁힌다.
    const yMax = Math.min(h - 4, Math.round(maxYpt * scale));
    for (let y = Math.round(40 * scale); y < yMax; y += 1) {
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


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mp4 = process.argv[2];
  if (!mp4) {
    console.error('usage: sheet-drag-track.mjs <녹화.mp4> [배율 3] [검색 상한 y pt] [화면 폭 pt — 주면 배율을 영상 폭에서 구한다]');
    process.exit(2);
  }
  const {rows} = trackSheetTop(mp4, Number(process.argv[3] ?? 3), Number(process.argv[4] ?? Infinity), process.argv[5] ? Number(process.argv[5]) : null);
  console.log(['t_ms,sheet_top_pt', ...rows.map(r => `${r.t},${r.top ?? ''}`)].join('\n'));
}
