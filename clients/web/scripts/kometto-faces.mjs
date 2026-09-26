// =============================================================================
// 코메토 플랫 표정 6종을 합성하고 검사한다 (#2806, ADR-0193 D9·D11).
// render-brand-icons.mjs가 부른다. 규격은 docs/brand/kometto/faces/expressions.md.
//
// owner가 고른 K6 플랫 두 장(K6-flat-dark·K6-flat-light)을 **그대로** 바탕으로 쓰고,
// 검은 얼굴 창 안의 눈만 바꾼다. 눈 모양은 codex CLI 이미지 생성(gpt-image)이 K6-flat-dark를
// 편집해 만든 래스터에서 가져온다. 생성물은 창 밖이 원본과 미세하게 어긋나므로(실측 평균 차
// 2.9, 16 초과 1.6%) 창 밖은 버리고 얼굴 창 부분만 잘라 `faces/src/kometto-{id}-gen.png`로
// 커밋한다. 그 크롭이 표정의 원본이다.
//
// 합성(테마마다):
//   1. K6 원본에서 얼굴 창을 찾는다. 씨앗 픽셀에서 어두운 픽셀(R+G+B < 150)을 flood fill,
//      그 안의 구멍(원래 눈)을 채우고, 창 가장자리를 ERODE px 깎는다(= 합성 마스크).
//   2. 생성 크롭의 밝기로 눈 층(0–1)을 잰다. 라이트는 두 원본의 대기 눈 쌍 상자를 잇는
//      사상으로 다크 좌표의 눈 층을 옮겨 온다(쌍선형).
//   3. 마스크 안은 「원본 창의 검정 ↔ 원본 눈의 크림」을 눈 층으로 섞는다. 마스크 밖은
//      원본 픽셀 그대로다. 색은 원본에서 재므로 눈은 원본과 같은 무광 크림 단색이다.
//   대기(idle)는 원본 그대로다(바이트가 같다).
//
// 검사(하나라도 어기면 실패):
//   - sha256: K6-flat-light, 생성 크롭 다섯 장이 고정값과 같다
//   - 합성물: 마스크 밖이 K6 원본과 픽셀까지 같다(다른 픽셀 0개)
//   - 합성물: 마스크 안이 생성 크롭에서 다시 합성한 것과 같다(평균 차 ≤ 0.5)
//   - 표정: 대기가 아닌 표정은 창 안이 대기와 충분히 다르고, 같은 테마의 표정끼리도 다르다
//   - 사상: 다크 대기 눈을 라이트로 옮긴 것이 K6-flat-light의 실제 눈과 맞는다(파생 임계)
//   - 웹 에셋: 576 RGBA·sRGB, 합성물에서 떠낸 것(평균 차 ≤ 0.5, 16 초과 ≤ 0.1%), 배지 밖 투명·가운데 불투명,
//     다크 대기 = 기존 S0 배지(kometto-badge.png)
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

export function faceThemes(repoRoot) {
  const k = (n) => resolve(repoRoot, "docs/brand/kometto", n);
  return {
    dark: {
      source: k("K6-flat-dark.png"),
      seed: [500, 560],
      /** 대기 눈 쌍의 상자(끝 픽셀 +1). 라이트 사상의 기준점. */
      eyes: { x0: 342, x1: 651, y0: 641, y1: 743 },
      /** 웹 에셋의 배지 원. S0 배지(render-brand-icons.mjs SOURCE_BADGE)와 같다. */
      badge: { cx: 626.5, cy: 625.5, r: 530.5 },
      /** 원 밖은 투명(S0 배지와 같은 방식). */
      cut: "circle",
    },
    light: {
      source: k("K6-flat-light.png"),
      seed: [500, 520],
      eyes: { x0: 323, x1: 647, y0: 631, y1: 741 },
      /** 크림 원(x 92–1155, y 97–1145)과 원 밖으로 나온 혜성 꼬리까지 담는 틀. */
      badge: { cx: 623.5, cy: 621, r: 533 },
      /** 원이 정원이 아니고 꼬리가 원 밖으로 나온다. 바깥 흰 바탕과 다른 픽셀을 남긴다. */
      cut: "background",
    },
  };
}

export const LIGHT_SOURCE_SHA256 = "7d5ad24bad1bab92214d62f267509aedbe87ebd6620c08f390a899f7b6123f90";

/**
 * 생성 크롭의 sha256. owner가 후보를 바꾸면 크롭과 이 값을 함께 바꾼다
 * (docs/brand/kometto/faces/expressions.md 「선택 기록」).
 */
export const GEN_SHA256 = {
  thinking: "ec4ed976aea0bf9889e8f45b1f79b73561f1d6bc765825eeed79a7467292dac6", // thinking-a
  happy: "5d2ded60ce1a2d0e22fe6ba086ea3118661fa180e259530c2ec1515a02c42ed6", // happy-a
  flustered: "3b4059368f5b3c079168b79c97936598caefe8bf7b40e08c83523bde6d7ed2eb", // flustered-b
  working: "aeaf3b574ab38978e4afb130066510ba0e5ae4283c661906bc7a8d6b0d93bc38", // working-a
  sleepy: "f6ed53796dbfd4cca6bcfbb674168775bd4a1b8993a5b563487e6158fdcc2924", // sleepy-a
};

export function facePaths(repoRoot, webRoot) {
  const faces = resolve(repoRoot, "docs/brand/kometto/faces");
  return {
    gen: (id) => resolve(faces, "src", `kometto-${id}-gen.png`),
    composite: (id, theme) => resolve(faces, `kometto-${id}-${theme}.png`),
    web: (id, theme) => resolve(webRoot, "src/assets/brand/kometto-faces", `${id}-${theme}.png`),
  };
}

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

// ---- 웹 에셋(576 RGBA) --------------------------------------------------------

export async function webInPage({ src, badge, cut, size, mode, cmp }) {
  const load = (data) =>
    new Promise((ok, no) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = no;
      img.src = "data:image/png;base64," + data;
    });
  const img = await load(src);
  const k = size / (2 * badge.r);
  const ox = -(badge.cx - badge.r) * k;
  const oy = -(badge.cy - badge.r) * k;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, ox, oy, img.naturalWidth * k, img.naturalHeight * k);
  const D = ctx.getImageData(0, 0, size, size);
  const d = D.data;
  // 바깥 바탕색: 원본 모서리.
  const s0 = document.createElement("canvas");
  s0.width = s0.height = 8;
  const sctx = s0.getContext("2d");
  sctx.drawImage(img, 0, 0, 8, 8, 0, 0, 8, 8);
  const bg = sctx.getImageData(4, 4, 1, 1).data;
  const alphaAt = (x, y, i) => {
    const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
    if (cut === "circle") return Math.min(1, Math.max(0, size / 2 - r)); // 1px 안티앨리어싱
    // background: 원 안쪽(가장자리 4px 전)은 불투명, 그 밖은 바탕과의 차로 알파.
    if (r < size / 2 - 4) return 1;
    const diff = Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2]));
    return Math.min(1, Math.max(0, (diff - 4) / 12));
  };
  const alpha = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const p = y * size + x;
      alpha[p] = alphaAt(x, y, p * 4);
    }
  if (mode === "render") {
    for (let p = 0; p < size * size; p++) d[p * 4 + 3] = Math.round(alpha[p] * 255);
    ctx.putImageData(D, 0, 0);
    return { png: c.toDataURL("image/png").split(",")[1] };
  }
  // check: 커밋된 에셋을 같은 방식으로 떠낸 것과 비교(알파가 있는 자리만).
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
  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    if (Math.abs(q[i + 3] - Math.round(alpha[p] * 255)) > 8) alphaOff++;
    if (q[i + 3] < 250 || alpha[p] < 0.99) continue;
    const m = Math.max(Math.abs(q[i] - d[i]), Math.abs(q[i + 1] - d[i + 1]), Math.abs(q[i + 2] - d[i + 2]));
    sum += (Math.abs(q[i] - d[i]) + Math.abs(q[i + 1] - d[i + 1]) + Math.abs(q[i + 2] - d[i + 2])) / 3;
    if (m > 16) over++;
    n++;
  }
  const A = (x, y) => q[(y * size + x) * 4 + 3];
  return {
    size: got.naturalWidth,
    mean: sum / n,
    over: over / n,
    alphaOff: alphaOff / (size * size),
    corner: A(3, 3),
    center: A(size >> 1, size >> 1),
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

export async function renderFaces(page, { repoRoot, webRoot, withSrgb, log }) {
  const T = faceThemes(repoRoot);
  const P = facePaths(repoRoot, webRoot);
  for (const [name, theme] of Object.entries(T)) {
    for (const id of FACE_IDS) {
      const out = P.composite(id, name);
      mkdirSync(dirname(out), { recursive: true });
      if (id === "idle") {
        writeFileSync(out, readFileSync(theme.source)); // 대기 = 원본 바이트
      } else {
        const r = await page.evaluate(composeInPage, {
          src: b64(theme.source),
          gen: b64(P.gen(id)),
          theme,
          dark: T.dark,
          crop: GEN_CROP,
          erode: ERODE,
          luma: EYE_LUMA,
          mode: "compose",
        });
        writeFileSync(out, withSrgb(Buffer.from(r.png, "base64")));
      }
      log(`wrote ${out}`);
      const web = P.web(id, name);
      mkdirSync(dirname(web), { recursive: true });
      const w = await page.evaluate(webInPage, {
        src: b64(out),
        badge: theme.badge,
        cut: theme.cut,
        size: WEB_SIZE,
        mode: "render",
      });
      writeFileSync(web, withSrgb(Buffer.from(w.png, "base64")));
      log(`wrote ${web}`);
    }
  }
}

/** 검사. fail(msg)로 어긴 것을 모으고, 보고용 표를 돌려준다. */
export async function checkFaces(page, { repoRoot, webRoot, fail, rel, s0Badge }) {
  const T = faceThemes(repoRoot);
  const P = facePaths(repoRoot, webRoot);
  const report = { shas: [], composites: [], mapping: null, web: [] };

  const lightSha = sha(T.light.source);
  if (lightSha !== LIGHT_SOURCE_SHA256)
    fail(`${rel(T.light.source)}: sha256 ${lightSha} ≠ 고정값 ${LIGHT_SOURCE_SHA256} (owner 레퍼런스가 아니다)`);
  report.shas.push([rel(T.light.source), lightSha]);
  for (const id of FACE_IDS.filter((i) => i !== "idle")) {
    const got = sha(P.gen(id));
    if (got !== GEN_SHA256[id]) fail(`${rel(P.gen(id))}: sha256 ${got} ≠ 고정값 ${GEN_SHA256[id] || "(없음)"}`);
    report.shas.push([rel(P.gen(id)), got]);
  }

  for (const [name, theme] of Object.entries(T)) {
    for (const id of FACE_IDS) {
      const path = P.composite(id, name);
      if (id === "idle") {
        const same = sha(path) === sha(theme.source);
        if (!same) fail(`${rel(path)}: 대기는 ${rel(theme.source)}와 바이트가 같아야 한다`);
        report.composites.push([rel(path), { idleSame: same }]);
        continue;
      }
      const others = Object.fromEntries(
        FACE_IDS.filter((o) => o !== id).map((o) => [o, b64(P.composite(o, name))])
      );
      const r = await page.evaluate(composeInPage, {
        src: b64(theme.source),
        gen: b64(P.gen(id)),
        theme,
        dark: T.dark,
        crop: GEN_CROP,
        erode: ERODE,
        luma: EYE_LUMA,
        mode: "check",
        cmp: { self: b64(path), others },
      });
      if (r.size[0] !== 1254 || r.size[1] !== 1254) fail(`${rel(path)}: ${r.size.join("x")}, 기대 1254x1254`);
      if (r.outsideDiff !== 0) fail(`${rel(path)}: 얼굴 창 밖이 K6 원본과 다르다 (${r.outsideDiff}px)`);
      if (!(r.recomposeMean <= FACE.recomposeMeanMax))
        fail(`${rel(path)}: 생성 크롭에서 합성한 것과 다르다 (창 안 평균 차 ${r.recomposeMean.toFixed(2)})`);
      if (!(r.changed >= FACE.changedMin))
        fail(`${rel(path)}: 대기와 거의 같다 (창 안 변화 ${(r.changed * 100).toFixed(2)}%)`);
      for (const [o, frac] of Object.entries(r.distinct))
        if (!(frac >= FACE.distinctMin)) fail(`${rel(path)}: ${o}와 구분되지 않는다 (${(frac * 100).toFixed(2)}%)`);
      report.composites.push([rel(path), r]);
    }
  }

  // 사상 검사: 다크 대기 눈(원본 창을 크롭)을 라이트로 옮겨 K6-flat-light와 비교.
  const idleCrop = await page.evaluate(
    async ({ src, crop }) => {
      const img = await new Promise((ok) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.src = "data:image/png;base64," + src;
      });
      const c = document.createElement("canvas");
      c.width = crop.w;
      c.height = crop.h;
      c.getContext("2d").drawImage(img, -crop.x, -crop.y);
      return c.toDataURL("image/png").split(",")[1];
    },
    { src: b64(T.dark.source), crop: GEN_CROP }
  );
  const mapped = await page.evaluate(composeInPage, {
    src: b64(T.light.source),
    gen: idleCrop,
    theme: T.light,
    dark: T.dark,
    crop: GEN_CROP,
    erode: ERODE,
    luma: EYE_LUMA,
    mode: "check",
    cmp: { self: b64(T.light.source), others: {} },
  });
  report.mapping = mapped;
  if (!(mapped.recomposeMean <= DERIVED.meanMax))
    fail(`사상: 다크 대기 눈을 라이트로 옮긴 것이 K6-flat-light 눈과 맞지 않는다 (평균 차 ${mapped.recomposeMean.toFixed(2)})`);

  for (const [name, theme] of Object.entries(T)) {
    for (const id of FACE_IDS) {
      const web = P.web(id, name);
      const png = readFileSync(web);
      const r = await page.evaluate(webInPage, {
        src: b64(P.composite(id, name)),
        badge: theme.badge,
        cut: theme.cut,
        size: WEB_SIZE,
        mode: "check",
        cmp: { self: png.toString("base64") },
      });
      const colorType = png[25];
      const hasSrgb = png.includes(Buffer.from("sRGB"));
      if (r.size !== WEB_SIZE) fail(`${rel(web)}: 폭 ${r.size}, 기대 ${WEB_SIZE}`);
      if (colorType !== 6) fail(`${rel(web)}: RGBA가 아니다(색 유형 ${colorType})`);
      if (!hasSrgb) fail(`${rel(web)}: sRGB 청크가 없다`);
      if (!(r.mean <= WEB_DERIVED.meanMax && r.over <= WEB_DERIVED.overMax && r.alphaOff <= 0.002))
        fail(
          `${rel(web)}: 합성물에서 파생되지 않았다 (평균 차 ${r.mean.toFixed(2)}, 16 초과 ${(r.over * 100).toFixed(2)}%, 알파 어긋남 ${(r.alphaOff * 100).toFixed(2)}%)`
        );
      if (r.corner !== 0 || r.center !== 255) fail(`${rel(web)}: 배지 밖이 투명하지 않거나 가운데가 비었다 ${JSON.stringify(r)}`);
      report.web.push([rel(web), r]);
    }
  }

  // 다크 대기 = S0 배지(리샘플러만 다르다: S0는 CSS 스크린샷, 표정은 canvas).
  report.idleVsS0 = await page.evaluate(pngDiff, { a: b64(P.web("idle", "dark")), b: b64(s0Badge) });
  if (!(report.idleVsS0.mean <= DERIVED.meanMax && report.idleVsS0.over <= DERIVED.overMax))
    fail(`${rel(P.web("idle", "dark"))}: S0 배지(kometto-badge.png)와 다르다 ${JSON.stringify(report.idleVsS0)}`);

  return report;
}
