// =============================================================================
// 코메토 플랫 표정 6종을 합성하고, 투명 컷 에셋을 떠내고, 검사한다 (#2806, ADR-0193 D9·D11).
// render-brand-icons.mjs가 부른다. 규격은 docs/brand/kometto/faces/expressions.md.
//
// owner가 고른 K6 플랫(K6-flat-dark)을 **그대로** 바탕으로 쓰고, 검은 얼굴 창 안의 눈만
// 바꾼다. 눈 모양은 codex CLI 이미지 생성(gpt-image)이 K6-flat-dark를 편집해 만든 래스터에서
// 가져온다. 생성물은 창 밖이 원본과 미세하게 어긋나므로(실측 평균 차 2.9, 16 초과 1.6%) 얼굴
// 창 부분만 잘라 `faces/src/kometto-{id}-gen.png`로 커밋한다. 그 크롭이 표정의 원본이다.
//
// 1. 합성(메모리 안, 파일로 쓰지 않는다): K6 원본에서 얼굴 창을 찾는다(씨앗 flood fill, 구멍
//    채우기, 가장자리 ERODE px 깎기). 그 마스크 안만 생성 크롭의 밝기로 원본 창 검정 ↔ 원본
//    눈 크림을 섞는다. 마스크 밖은 원본 픽셀 그대로다. 대기(idle)는 원본 그대로다.
// 2. 투명 컷(M2, planner 판정 2026-09-26 (c)): 합성물에서 배지 원판과 바깥 바탕을 걷어 내고,
//    몸이 원에서 잘린 자리는 부드럽게 사라지게 한다(cutInPage 머리말). 웹 576px, 폰 600px.
//
// 검사(하나라도 어기면 실패):
//   - sha256: K6-flat-dark와 생성 크롭 다섯 장이 고정값과 같다
//   - 합성: 마스크 밖이 K6 원본과 픽셀까지 같다. 대기가 아닌 표정은 창 안이 대기와 1% 이상,
//     서로 0.5% 이상 다르다
//   - 에셋: 크기·RGBA·sRGB. 합성물에서 다시 떠낸 것과 같다(평균 차 ≤ 0.5, 16 초과 ≤ 0.1%,
//     알파 어긋남 ≤ 0.2%). 모서리·원판 자리 투명, 얼굴 불투명
//   - 대기 웹 에셋의 불투명 픽셀이 S0 배지(kometto-badge.png)와 같은 그림이다
// =============================================================================

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const FACE_IDS = ["idle", "thinking", "happy", "flustered", "working", "sleepy"];

/** 생성 크롭의 자리(K6-flat-dark 좌표). 다크 얼굴 창 상자 x 292–720, y 450–843을 감싼다. */
export const GEN_CROP = { x: 280, y: 440, w: 452, h: 416 };
/** 창 가장자리에서 깎는 폭(px). 창 테두리의 안티앨리어싱은 원본 그대로 남긴다. */
export const ERODE = 10;
/** 눈 층: 밝기(Rec.709) 40 이하 0, 230 이상 1. */
export const EYE_LUMA = { lo: 40, hi: 230 };

/** 합성물 판정 임계. */
const FACE = {
  recomposeMeanMax: 0.5,
  /** 대기와 다른 창 안 픽셀(최대 채널 차 > 64)의 최소 비율 */
  changedMin: 0.01,
  /** 같은 테마 표정 쌍의 창 안 다른 픽셀 최소 비율 */
  distinctMin: 0.005,
};
/** 파생 판정 임계(render-brand-icons.mjs DERIVED와 같다). */
const DERIVED = { meanMax: 3, overMax: 0.02 };
/**
 * 웹 에셋 판정 임계. 에셋과 검사가 같은 canvas 경로로 떠내므로 실측은 0.00이다. 표정끼리의
 * 차이는 눈 자리뿐이라(576 캔버스의 1–2%) DERIVED로는 표정을 바꿔 끼운 것을 못 잡는다(#2806 사보타주 S5).
 */
const WEB_DERIVED = { meanMax: 0.5, overMax: 0.001 };
export const WEB_SIZE = 576;
export const PHONE_SIZE = 600;

export function faceSource(repoRoot) {
  return {
    source: resolve(repoRoot, "docs/brand/kometto/K6-flat-dark.png"),
    seed: [500, 560],
    /** 대기 눈 쌍의 상자(끝 픽셀 +1). composeInPage의 좌표 사상 기준(다크 → 다크, 항등). */
    eyes: { x0: 342, x1: 651, y0: 641, y1: 743 },
    /** 에셋 틀 = 배지 원. S0 배지(render-brand-icons.mjs SOURCE_BADGE)와 같다. */
    badge: { cx: 626.5, cy: 625.5, r: 530.5 },
    /** 원판 색을 재는 자리(원본 좌표). */
    disc: [140, 626],
  };
}

/**
 * 생성 크롭의 sha256. owner가 후보를 바꾸면 크롭과 이 값을 함께 바꾼다
 * (docs/brand/kometto/faces/expressions.md 「후보와 선택 기록」).
 */
export const K6_DARK_SHA256 = "f0a75497fc609277ce5515ef96455f8f6d83d236dfa581290611b00ca08bab58";

export const GEN_SHA256 = {
  thinking: "ec4ed976aea0bf9889e8f45b1f79b73561f1d6bc765825eeed79a7467292dac6", // thinking-a
  happy: "5d2ded60ce1a2d0e22fe6ba086ea3118661fa180e259530c2ec1515a02c42ed6", // happy-a
  flustered: "3b4059368f5b3c079168b79c97936598caefe8bf7b40e08c83523bde6d7ed2eb", // flustered-b
  working: "aeaf3b574ab38978e4afb130066510ba0e5ae4283c661906bc7a8d6b0d93bc38", // working-a
  sleepy: "f6ed53796dbfd4cca6bcfbb674168775bd4a1b8993a5b563487e6158fdcc2924", // sleepy-a
};

/** 에셋 두 벌: 웹 576(히어로 192×3x, 데스크탑 280@2x=560), 폰 600(히어로 200pt@3x). */
export function faceTargets(repoRoot, webRoot) {
  return [
    { name: "web", size: WEB_SIZE, path: (id) => resolve(webRoot, "src/assets/brand/kometto-faces", `${id}.png`) },
    { name: "phone", size: PHONE_SIZE, path: (id) => resolve(repoRoot, "clients/mobile/src/design/brand/kometto-faces", `${id}.png`) },
  ];
}
export const genPath = (repoRoot, id) => resolve(repoRoot, "docs/brand/kometto/faces/src", `kometto-${id}-gen.png`);

const b64 = (p) => readFileSync(p).toString("base64");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// ---- 브라우저 안 합성 ---------------------------------------------------------
//
// page.evaluate로 넘기는 함수. 문자열로 직렬화되므로 바깥 변수를 쓰지 않는다.

export async function composeInPage({ src, gen, theme, dark, crop, erode, luma, mode, cmp }) {
  const load = (data) =>
    new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = no;
      img.src = "data:image/png;base64," + data;
    });
  const pixels = async (data) => {
    const img = await load(data);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  };
  const S = await pixels(src);
  const W = S.width;
  const H = S.height;
  const s = S.data;

  // 1. 얼굴 창: 씨앗에서 어두운 픽셀 flood fill → 구멍 채우기 → ERODE px 깎기.
  const dark3 = (i) => s[i] + s[i + 1] + s[i + 2] < 150;
  const win = new Uint8Array(W * H);
  {
    const stack = [theme.seed[1] * W + theme.seed[0]];
    while (stack.length) {
      const p = stack.pop();
      if (win[p] || !dark3(p * 4)) continue;
      win[p] = 1;
      const x = p % W;
      if (x > 0) stack.push(p - 1);
      if (x < W - 1) stack.push(p + 1);
      if (p >= W) stack.push(p - W);
      if (p < W * (H - 1)) stack.push(p + W);
    }
    // 구멍 채우기: 창이 아닌 픽셀 중 가장자리에서 닿지 않는 것은 창 안(원래 눈)이다.
    const out = new Uint8Array(W * H);
    const st = [];
    for (let x = 0; x < W; x++) st.push(x, (H - 1) * W + x);
    for (let y = 0; y < H; y++) st.push(y * W, y * W + W - 1);
    while (st.length) {
      const p = st.pop();
      if (out[p] || win[p]) continue;
      out[p] = 1;
      const x = p % W;
      if (x > 0) st.push(p - 1);
      if (x < W - 1) st.push(p + 1);
      if (p >= W) st.push(p - W);
      if (p < W * (H - 1)) st.push(p + W);
    }
    for (let p = 0; p < W * H; p++) if (!out[p]) win[p] = 1;
  }
  let mask = win;
  for (let k = 0; k < erode; k++) {
    const next = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        next[p] = mask[p] && mask[p - 1] && mask[p + 1] && mask[p - W] && mask[p + W] ? 1 : 0;
      }
    mask = next;
  }

  // 원본의 창 검정과 눈 크림(중앙값).
  const median = (vals) => {
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  };
  const collect = (test) => {
    const ch = [[], [], []];
    for (let p = 0; p < W * H; p++) {
      if (!win[p]) continue;
      const i = p * 4;
      if (!test(i)) continue;
      ch[0].push(s[i]);
      ch[1].push(s[i + 1]);
      ch[2].push(s[i + 2]);
    }
    return ch.map(median);
  };
  const black = collect((i) => mask[i / 4] && dark3(i));
  const cream = collect((i) => Math.min(s[i], s[i + 1], s[i + 2]) > 200);

  // 2. 눈 층. gen은 다크 좌표 GEN_CROP 자리의 크롭이다.
  let eye = null;
  if (gen) {
    const G = await pixels(gen);
    const g = G.data;
    const a = new Float32Array(G.width * G.height);
    for (let p = 0; p < a.length; p++) {
      const i = p * 4;
      const L = 0.2126 * g[i] + 0.7152 * g[i + 1] + 0.0722 * g[i + 2];
      a[p] = Math.min(1, Math.max(0, (L - luma.lo) / (luma.hi - luma.lo)));
    }
    // 다크 좌표 (xd, yd)의 눈 층(쌍선형, 크롭 밖 0).
    const at = (xd, yd) => {
      const fx = xd - crop.x - 0.5;
      const fy = yd - crop.y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const v = (x, y) => (x < 0 || y < 0 || x >= G.width || y >= G.height ? 0 : a[y * G.width + x]);
      return (
        v(x0, y0) * (1 - tx) * (1 - ty) + v(x0 + 1, y0) * tx * (1 - ty) + v(x0, y0 + 1) * (1 - tx) * ty + v(x0 + 1, y0 + 1) * tx * ty
      );
    };
    // 이 테마 좌표 → 다크 좌표: 대기 눈 쌍 상자를 잇는 사상(다크는 항등).
    const e = theme.eyes;
    const d = dark.eyes;
    const sx = (d.x1 - d.x0) / (e.x1 - e.x0);
    const sy = (d.y1 - d.y0) / (e.y1 - e.y0);
    eye = (x, y) => at(d.x0 + (x + 0.5 - e.x0) * sx, d.y0 + (y + 0.5 - e.y0) * sy);
  }

  // 3. 합성.
  const O = new ImageData(new Uint8ClampedArray(s), W, H);
  const o = O.data;
  if (eye) {
    for (let p = 0; p < W * H; p++) {
      if (!mask[p]) continue;
      const x = p % W;
      const y = (p - x) / W;
      const t = eye(x, y);
      const i = p * 4;
      for (let c = 0; c < 3; c++) o[i + c] = Math.round(black[c] * (1 - t) + cream[c] * t);
      o[i + 3] = 255;
    }
  }

  if (mode === "compose") {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    c.getContext("2d").putImageData(O, 0, 0);
    return { png: c.toDataURL("image/png").split(",")[1], black, cream, maskPx: mask.reduce((n, v) => n + v, 0) };
  }

  // mode === "check": cmp(커밋된 합성물)과 비교한다. others = 같은 테마 다른 표정들.
  const C = await pixels(cmp.self);
  const q = C.data;
  let outsideDiff = 0;
  let insideSum = 0;
  let insideN = 0;
  let changed = 0;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const d3 = Math.max(Math.abs(q[i] - s[i]), Math.abs(q[i + 1] - s[i + 1]), Math.abs(q[i + 2] - s[i + 2]));
    if (!mask[p]) {
      if (d3 !== 0 || q[i + 3] !== 255) outsideDiff++;
      continue;
    }
    insideSum += (Math.abs(q[i] - o[i]) + Math.abs(q[i + 1] - o[i + 1]) + Math.abs(q[i + 2] - o[i + 2])) / 3;
    insideN++;
    if (d3 > 64) changed++;
  }
  const distinct = {};
  for (const [id, data] of Object.entries(cmp.others)) {
    const X = (await pixels(data)).data;
    let n = 0;
    for (let p = 0; p < W * H; p++) {
      if (!mask[p]) continue;
      const i = p * 4;
      if (Math.max(Math.abs(q[i] - X[i]), Math.abs(q[i + 1] - X[i + 1]), Math.abs(q[i + 2] - X[i + 2])) > 64) n++;
    }
    distinct[id] = n / insideN;
  }
  return { size: [C.width, C.height], outsideDiff, recomposeMean: insideSum / insideN, changed: changed / insideN, distinct };
}

// ---- 투명 컷 (M2) ---------------------------------------------------------------
//
// 배지 원판과 바깥 바탕을 걷어 내고 캐릭터만 남긴다(#2806 M2, planner 판정 2026-09-26 (c)).
// 새로 그리지 않는다. 합성물을 틀(badge)에 맞춰 줄인 뒤:
//   1. 키잉: 네 모서리에서 flood fill. 「바깥 바탕 ↔ 원판색」 선분까지 거리 ≤ KEY_T인
//      픽셀이 배경이다(두 색 사이 안티앨리어싱도 함께 걷힌다).
//   2. 가장자리 2px 띠만 투영 매팅: 가장 가까운 배경 픽셀 색을 바탕, 가장 가까운 안쪽
//      캐릭터 픽셀 색을 전경으로 보고 알파를 매긴 뒤 바탕색을 걷어 낸다(흰 테·남색 테 방지).
//   3. 원호 자름 페이드: 몸이 배지 원에서 잘린 자리(캐릭터가 원판이 아니라 바깥 바탕과
//      맞닿고 그 자리가 배지 원 반지름 ±CUT_R_TOL 안)에서 안쪽으로 FADE_FRAC×크기 동안
//      알파를 smoothstep으로 0까지 내린다. 거리는 자름 경계 픽셀에서 잰 챔퍼 거리다.
//      잘린 단면이 딱딱한 원호로 보이지 않고 몸이 아래로 사라지게 한다.

export const KEY_T = 10;
export const FADE_FRAC = 0.1;
const CUT_R_TOL = 0.035;

export async function cutInPage({ src, badge, disc, size, mode, cmp, keyT, fadeFrac, cutTol }) {
  const load = (data) =>
    new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = no;
      img.src = "data:image/png;base64," + data;
    });
  const img = await load(src);
  const k = size / (2 * badge.r);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, -(badge.cx - badge.r) * k, -(badge.cy - badge.r) * k, img.naturalWidth * k, img.naturalHeight * k);
  const D = ctx.getImageData(0, 0, size, size);
  const d = D.data;
  const N = size * size;

  // 바탕·원판 색(원본 픽셀 중앙값).
  const full = document.createElement("canvas");
  full.width = img.naturalWidth;
  full.height = img.naturalHeight;
  const fctx = full.getContext("2d");
  fctx.drawImage(img, 0, 0);
  const sample = (x0, y0) => {
    const q = fctx.getImageData(x0 - 4, y0 - 4, 9, 9).data;
    const ch = [[], [], []];
    for (let i = 0; i < q.length; i += 4) for (let cc = 0; cc < 3; cc++) ch[cc].push(q[i + cc]);
    return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
  };
  const bg = sample(8, 8);
  const dc = sample(disc[0], disc[1]);

  // 1. 키잉.
  const seg = [dc[0] - bg[0], dc[1] - bg[1], dc[2] - bg[2]];
  const segLen2 = seg[0] ** 2 + seg[1] ** 2 + seg[2] ** 2;
  const toKey = (i) => {
    const v = [d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]];
    const t = Math.min(1, Math.max(0, (v[0] * seg[0] + v[1] * seg[1] + v[2] * seg[2]) / segLen2));
    return Math.hypot(v[0] - t * seg[0], v[1] - t * seg[1], v[2] - t * seg[2]);
  };
  const key = new Uint8Array(N);
  {
    const st = [0, size - 1, N - size, N - 1];
    while (st.length) {
      const p = st.pop();
      if (key[p] || toKey(p * 4) > keyT) continue;
      key[p] = 1;
      const x = p % size;
      if (x > 0) st.push(p - 1);
      if (x < size - 1) st.push(p + 1);
      if (p >= size) st.push(p - size);
      if (p < N - size) st.push(p + size);
    }
  }
  const near = (x, y, rad, arr) => {
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < size && ny < size && arr[ny * size + nx]) return true;
      }
    return false;
  };
  const alpha = new Float32Array(N);
  const band = new Uint8Array(N);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (key[p]) continue;
      if (near(x, y, 2, key)) band[p] = 1;
      else alpha[p] = 1;
    }

  // 2. 가장자리 매팅.
  const nearest = (x, y, test) => {
    let best = Infinity;
    let j = -1;
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const q = ny * size + nx;
        if (!test(q)) continue;
        const dd = dx * dx + dy * dy;
        if (dd < best) {
          best = dd;
          j = q * 4;
        }
      }
    return j;
  };
  const localBg = new Float32Array(N * 3);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (!band[p]) continue;
      const i = p * 4;
      const b = nearest(x, y, (q) => key[q]);
      const f = nearest(x, y, (q) => !key[q] && !band[q]);
      const B = b < 0 ? bg : [d[b], d[b + 1], d[b + 2]];
      localBg.set(B, p * 3);
      if (f < 0) {
        alpha[p] = 0.5;
        continue;
      }
      let num = 0;
      let den = 0;
      for (let cc = 0; cc < 3; cc++) {
        const fv = d[f + cc] - B[cc];
        num += (d[i + cc] - B[cc]) * fv;
        den += fv * fv;
      }
      alpha[p] = den < 100 ? 1 : Math.min(1, Math.max(0, num / den));
    }

  // 3. 원호 자름 페이드. 자름 경계 = 캐릭터와 맞닿은 배경 픽셀 중, 바깥 바탕색에 가깝고
  //    (원판이 아니고) 배지 원 반지름 근처인 것.
  const R = size / 2;
  const isOuter = (i) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) < Math.hypot(d[i] - dc[0], d[i + 1] - dc[1], d[i + 2] - dc[2]);
  const INF = 1e9;
  const dist = new Float32Array(N).fill(INF);
  let cutPx = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      if (!key[p] || !isOuter(p * 4)) continue;
      const r = Math.hypot(x + 0.5 - R, y + 0.5 - R);
      if (Math.abs(r - R) > cutTol * size) continue;
      let touches = false;
      for (const q of [p - 1, p + 1, p - size, p + size]) if (q >= 0 && q < N && !key[q]) touches = true;
      if (touches) {
        dist[p] = 0;
        cutPx++;
      }
    }
  // 챔퍼 거리(3-4 근사, /3).
  const A = 1;
  const Bd = Math.SQRT2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      let v = dist[p];
      if (x > 0) v = Math.min(v, dist[p - 1] + A);
      if (y > 0) {
        v = Math.min(v, dist[p - size] + A);
        if (x > 0) v = Math.min(v, dist[p - size - 1] + Bd);
        if (x < size - 1) v = Math.min(v, dist[p - size + 1] + Bd);
      }
      dist[p] = v;
    }
  for (let y = size - 1; y >= 0; y--)
    for (let x = size - 1; x >= 0; x--) {
      const p = y * size + x;
      let v = dist[p];
      if (x < size - 1) v = Math.min(v, dist[p + 1] + A);
      if (y < size - 1) {
        v = Math.min(v, dist[p + size] + A);
        if (x < size - 1) v = Math.min(v, dist[p + size + 1] + Bd);
        if (x > 0) v = Math.min(v, dist[p + size - 1] + Bd);
      }
      dist[p] = v;
    }
  const F = fadeFrac * size;
  for (let p = 0; p < N; p++) {
    if (alpha[p] === 0 || dist[p] >= F) continue;
    const t = dist[p] / F;
    alpha[p] *= t * t * (3 - 2 * t);
  }

  // 색: 반투명 가장자리 띠는 바탕색을 걷어 낸다. 페이드 구간은 색을 그대로 둔다.
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    if (band[p] && alpha[p] > 0 && alpha[p] < 1) {
      for (let cc = 0; cc < 3; cc++) {
        const B = localBg[p * 3 + cc];
        d[i + cc] = Math.min(255, Math.max(0, Math.round((d[i + cc] - B * (1 - alpha[p])) / alpha[p])));
      }
    }
  }
  const out = new Uint8ClampedArray(d);
  for (let p = 0; p < N; p++) out[p * 4 + 3] = Math.round(alpha[p] * 255);
  if (mode === "render") {
    ctx.putImageData(new ImageData(out, size, size), 0, 0);
    return { png: c.toDataURL("image/png").split(",")[1], cutPx, keyed: key.reduce((n, v) => n + v, 0) };
  }
  // check: 커밋된 에셋과 같은 방식으로 떠낸 것을 비교(RGBA, 알파 가중).
  const got = await load(cmp.self);
  const g = document.createElement("canvas");
  g.width = g.height = size;
  const gctx = g.getContext("2d");
  gctx.drawImage(got, 0, 0);
  const q = gctx.getImageData(0, 0, size, size).data;
  let sum = 0;
  let n = 0;
  let over = 0;
  let alphaOff = 0;
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    if (Math.abs(q[i + 3] - out[i + 3]) > 8) alphaOff++;
    if (q[i + 3] < 250 || out[i + 3] < 250) continue;
    const m = Math.max(Math.abs(q[i] - out[i]), Math.abs(q[i + 1] - out[i + 1]), Math.abs(q[i + 2] - out[i + 2]));
    sum += (Math.abs(q[i] - out[i]) + Math.abs(q[i + 1] - out[i + 1]) + Math.abs(q[i + 2] - out[i + 2])) / 3;
    if (m > 16) over++;
    n++;
  }
  const at = (x, y) => q[(y * size + x) * 4 + 3];
  return {
    size: got.naturalWidth,
    mean: sum / n,
    over: over / n,
    alphaOff: alphaOff / N,
    corner: at(3, 3),
    discPx: at(Math.round(disc[0] * k - (badge.cx - badge.r) * k), Math.round(disc[1] * k - (badge.cy - badge.r) * k)),
    face: at(Math.round(size * 0.35), Math.round(size * 0.5)),
    cutPx,
  };
}

/** 같은 크기 RGBA 두 장의 평균 차(0–255)와 16 초과 비율. 둘 다 불투명한 자리만. */
async function pngDiff({ a, b }) {
  const px = (data) =>
    new Promise((ok) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        ok(ctx.getImageData(0, 0, c.width, c.height).data);
      };
      img.src = "data:image/png;base64," + data;
    });
  const [A, B] = [await px(a), await px(b)];
  let sum = 0;
  let n = 0;
  let over = 0;
  for (let i = 0; i < A.length; i += 4) {
    if (A[i + 3] < 250 || B[i + 3] < 250) continue;
    const d = [0, 1, 2].map((c) => Math.abs(A[i + c] - B[i + c]));
    sum += (d[0] + d[1] + d[2]) / 3;
    if (Math.max(...d) > 16) over++;
    n++;
  }
  return { mean: sum / n, over: over / n };
}

// ---- 공개 함수 ----------------------------------------------------------------

async function composite(page, repoRoot, id) {
  const S = faceSource(repoRoot);
  if (id === "idle") return b64(S.source);
  const r = await page.evaluate(composeInPage, {
    src: b64(S.source),
    gen: b64(genPath(repoRoot, id)),
    theme: S,
    dark: S,
    crop: GEN_CROP,
    erode: ERODE,
    luma: EYE_LUMA,
    mode: "compose",
  });
  return r.png;
}

const cutArgs = (S, size) => ({ badge: S.badge, disc: S.disc, size, keyT: KEY_T, fadeFrac: FADE_FRAC, cutTol: CUT_R_TOL });

export async function renderFaces(page, { repoRoot, webRoot, withSrgb, log }) {
  const S = faceSource(repoRoot);
  for (const id of FACE_IDS) {
    const comp = await composite(page, repoRoot, id);
    for (const t of faceTargets(repoRoot, webRoot)) {
      const out = t.path(id);
      mkdirSync(dirname(out), { recursive: true });
      const r = await page.evaluate(cutInPage, { src: comp, ...cutArgs(S, t.size), mode: "render" });
      writeFileSync(out, withSrgb(Buffer.from(r.png, "base64")));
      log(`wrote ${out}`);
    }
  }
}

/** 검사. fail(msg)로 어긴 것을 모으고, 보고용 표를 돌려준다. */
export async function checkFaces(page, { repoRoot, webRoot, fail, rel, s0Badge }) {
  const S = faceSource(repoRoot);
  const report = { shas: [], composites: [], assets: [] };

  const k6 = sha(S.source);
  if (k6 !== K6_DARK_SHA256) fail(`${rel(S.source)}: sha256 ${k6} ≠ 고정값 ${K6_DARK_SHA256} (owner 레퍼런스가 아니다)`);
  report.shas.push([rel(S.source), k6]);
  for (const id of FACE_IDS.filter((i) => i !== "idle")) {
    const got = sha(genPath(repoRoot, id));
    if (got !== GEN_SHA256[id]) fail(`${rel(genPath(repoRoot, id))}: sha256 ${got} ≠ 고정값 ${GEN_SHA256[id]}`);
    report.shas.push([rel(genPath(repoRoot, id)), got]);
  }

  const comps = {};
  for (const id of FACE_IDS) comps[id] = await composite(page, repoRoot, id);
  for (const id of FACE_IDS.filter((i) => i !== "idle")) {
    const others = Object.fromEntries(FACE_IDS.filter((o) => o !== id).map((o) => [o, comps[o]]));
    const r = await page.evaluate(composeInPage, {
      src: b64(S.source),
      gen: b64(genPath(repoRoot, id)),
      theme: S,
      dark: S,
      crop: GEN_CROP,
      erode: ERODE,
      luma: EYE_LUMA,
      mode: "check",
      cmp: { self: comps[id], others },
    });
    if (r.outsideDiff !== 0) fail(`합성 ${id}: 얼굴 창 밖이 K6 원본과 다르다 (${r.outsideDiff}px)`);
    if (!(r.changed >= FACE.changedMin)) fail(`합성 ${id}: 대기와 거의 같다 (창 안 변화 ${(r.changed * 100).toFixed(2)}%)`);
    for (const [o, frac] of Object.entries(r.distinct))
      if (!(frac >= FACE.distinctMin)) fail(`합성 ${id}: ${o}와 구분되지 않는다 (${(frac * 100).toFixed(2)}%)`);
    report.composites.push([id, r]);
  }

  for (const t of faceTargets(repoRoot, webRoot)) {
    for (const id of FACE_IDS) {
      const path = t.path(id);
      const png = readFileSync(path);
      const r = await page.evaluate(cutInPage, {
        src: comps[id],
        ...cutArgs(S, t.size),
        mode: "check",
        cmp: { self: png.toString("base64") },
      });
      if (r.size !== t.size) fail(`${rel(path)}: 폭 ${r.size}, 기대 ${t.size}`);
      if (png[25] !== 6) fail(`${rel(path)}: RGBA가 아니다(색 유형 ${png[25]})`);
      if (!png.includes(Buffer.from("sRGB"))) fail(`${rel(path)}: sRGB 청크가 없다`);
      if (!(r.mean <= WEB_DERIVED.meanMax && r.over <= WEB_DERIVED.overMax && r.alphaOff <= 0.002))
        fail(
          `${rel(path)}: 합성물에서 떠낸 것과 다르다 (평균 차 ${r.mean.toFixed(2)}, 16 초과 ${(r.over * 100).toFixed(2)}%, 알파 어긋남 ${(r.alphaOff * 100).toFixed(2)}%)`
        );
      if (r.corner !== 0 || r.discPx !== 0 || r.face !== 255)
        fail(`${rel(path)}: 모서리·원판이 투명하지 않거나 얼굴이 비었다 (모서리 ${r.corner}, 원판 ${r.discPx}, 얼굴 ${r.face})`);
      report.assets.push([rel(path), r]);
    }
  }

  // 대기 웹 에셋의 불투명 픽셀 = S0 배지의 같은 자리(캐릭터가 같은 그림인가).
  report.idleVsS0 = await page.evaluate(pngDiff, { a: b64(faceTargets(repoRoot, webRoot)[0].path("idle")), b: b64(s0Badge) });
  if (!(report.idleVsS0.mean <= DERIVED.meanMax && report.idleVsS0.over <= DERIVED.overMax))
    fail(`대기 웹 에셋이 S0 배지(kometto-badge.png)와 다른 그림이다 ${JSON.stringify(report.idleVsS0)}`);

  return report;
}
