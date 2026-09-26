#!/usr/bin/env node
// =============================================================================
// oort 앱 아이콘·S0 히어로·파비콘의 래스터를 떠내고 검사한다 (#2650, #2732).
//
//   npm run icons:brand           -> brand-mark.mjs로 C2-04 SVG를 다시 쓴 뒤 이 파일
//   node scripts/render-brand-icons.mjs --check-only
//                                 -> 다시 뜨지 않고 커밋된 래스터만 검사
//
// 앱 아이콘과 온보딩 S0 히어로는 owner가 고른 **코메토 K6 플랫 레퍼런스 래스터를
// 그대로** 크롭·리사이즈한다(#2732 R2, owner 2026-09-26: 「레퍼런스 선택한걸 왜
// 그대로 안쓰고 굳이 다른 형태로 만들어 ?」). 다시 그리거나 비례를 바꾸지 않는다.
// 원본은 docs/brand/kometto/K6-flat-dark.png(1254×1254, 불투명)이고, 해시를 아래에
// 고정한다. 떠내는 것:
//
//   폰    clients/mobile/ios/.../AppIcon-1024.png   원본을 1024로(바탕이 끝까지, RGB)
//   웹    public/apple-touch-icon.png  180 / public/icon-192.png / public/icon-512.png
//         public/icon-maskable-512.png 원본을 줄여 배지 원이 안전 원 안에 들게, 둘레는 원본 바탕색
//         src/assets/brand/kometto-badge.png  S0 히어로. 배지 원만 오려 낸 576 RGBA
//   데스크탑 clients/desktop/src-tauri/app-icon.png  1024 RGBA, 824 그리드 둥근 판 안에 원본
//         → `cargo tauri icon app-icon.png`가 icons/*(icns·ico 포함)를 만든다
//         → icns의 32px 이하 세 칸을 C2-04 small 타일(favicon.svg)로 바꿔 끼운다(iconutil)
//   탭    public/favicon-32.png  C2-04 small 타일(favicon.svg)
//
// 작은 크기(#2732): 캐릭터는 32px 미만(macOS 판은 64px 미만)에서 눈과 말풍선
// 꼬리가 읽히지 않는다(docs/brand/mark/README.md). 그 자리는 C2-04 small 타일이다.
//
// 검사(하나라도 어기면 exit 1):
//   - 원본: 커밋된 레퍼런스의 sha256이 고정값과 같다
//   - 파생: 캐릭터 래스터마다, 원본을 같은 크기·같은 자리로 따로 줄여 그린 것과
//     픽셀을 비교한다. 평균 차(0–255)와 16 넘게 다른 픽셀의 비율이 임계 안이다
//   - 크기·알파·sRGB: IHDR 크기, iOS·웹 전면판은 RGB(알파 없음), macOS·S0는 RGBA
//   - macOS 판: 모서리 밖 투명, 판 안 불투명. S0 배지: 원 밖 투명, 가운데 불투명
//   - maskable: 바탕과 다른 가장 먼 픽셀이 지름 80% 안전 원 안
//   - icns 32px 이하 세 칸이 C2-04 small 타일이다
//   - C2-04: 단색판·파비콘 대비 3:1, small·파비콘 16/24/32px 틈(#2650)
// =============================================================================

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { chromium } from "playwright";
import { COLORS, PARAMS, buildMark } from "./brand-mark.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const MARK_DIR = resolve(REPO_ROOT, "docs/brand/mark");
const PUBLIC_DIR = resolve(WEB_ROOT, "public");
const TAURI_DIR = resolve(REPO_ROOT, "clients/desktop/src-tauri");
const IOS_ICON = resolve(
  REPO_ROOT,
  "clients/mobile/ios/MomoMobile/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png"
);
const S0_BADGE = resolve(WEB_ROOT, "src/assets/brand/kometto-badge.png");

const svg = (path) => readFileSync(path, "utf8");
const FAVICON = resolve(PUBLIC_DIR, "favicon.svg");
const SMALL = resolve(MARK_DIR, "oort-mark-small-black.svg");

// ---- 레퍼런스 ------------------------------------------------------------------

/** owner가 고른 원본. claudedocs/brand-2.0/round3/K6-flat-dark.png와 같은 바이트. */
export const SOURCE = resolve(REPO_ROOT, "docs/brand/kometto/K6-flat-dark.png");
export const SOURCE_SHA256 = "f0a75497fc609277ce5515ef96455f8f6d83d236dfa581290611b00ca08bab58";
const SOURCE_SIZE = 1254;
/** 원본의 남색 배지 원(픽셀 실측: 가로 96–1157, 세로 95–). 캐릭터는 모두 이 원 안이다. */
export const SOURCE_BADGE = { cx: 626.5, cy: 625.5, r: 530.5 };

const MACOS = { inset: 100, side: 824, radius: 185.4 };
/** W3C maskable 안전 원(지름 80%)의 반지름에 반올림 여유 0.95를 곱한 값. */
const SAFE_RADIUS = 0.4 * 0.95;
const S0_SIZE = 576; // S0 히어로 상한 192px × 3x

/** 파생 판정 임계. 평균 차(0–255)와 16 넘게 다른 픽셀의 비율. */
const DERIVED = { meanMax: 3, overMax: 0.02 };

const ICNS_TILE_SLOTS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
];

const failures = [];
const fail = (msg) => failures.push(msg);
const rel = (p) => relative(REPO_ROOT, p);

// ---- PNG 청크 ----------------------------------------------------------------

function chunks(png) {
  const list = [];
  for (let at = 8; at + 8 <= png.length; at += 12 + png.readUInt32BE(at)) {
    list.push({ type: png.toString("latin1", at + 4, at + 8), at, size: png.readUInt32BE(at) });
  }
  return list;
}

/** IHDR 바로 뒤에 sRGB(지각적 렌더링 의도) 청크를 넣는다. 이미 있으면 그대로. */
function withSrgb(png) {
  if (chunks(png).some((c) => c.type === "sRGB")) return png;
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  const body = Buffer.from([0x73, 0x52, 0x47, 0x42, 0x00]); // "sRGB" + intent 0
  const chunk = Buffer.alloc(4 + body.length + 4);
  chunk.writeUInt32BE(1, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body) >>> 0, 4 + body.length);
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}

function checkPng(path, { size, rgb }) {
  const png = readFileSync(path);
  const list = chunks(png).map((c) => c.type);
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const colorType = png[25];
  if (w !== size || h !== size) fail(`${rel(path)}: ${w}x${h}, 기대 ${size}x${size}`);
  if (rgb && (colorType !== 2 || list.includes("tRNS")))
    fail(`${rel(path)}: 알파가 있다(색 유형 ${colorType}${list.includes("tRNS") ? ", tRNS" : ""})`);
  if (!rgb && colorType !== 6) fail(`${rel(path)}: RGBA가 아니다(색 유형 ${colorType})`);
  if (!list.includes("sRGB")) fail(`${rel(path)}: sRGB 청크가 없다`);
  return { w, h, colorType, srgb: list.includes("sRGB") };
}

// ---- 대비 (C2-04) ------------------------------------------------------------

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const MARK_PAIRS = [
  ["파비콘 링 / 타일", COLORS.paper, COLORS.ink],
  ["파비콘 위성 / 타일", COLORS.amber, COLORS.ink],
  ["단색 검정 / 흰 바탕", COLORS.ink, COLORS.white],
  ["단색 흰색 / 검정 바탕", COLORS.white, COLORS.ink],
  ["단색 호박 / 검정 바탕", COLORS.amber, COLORS.ink],
];

// ---- 레퍼런스에서 떠내기 -----------------------------------------------------
//
// 원본 한 장을 CSS로 놓고 크로미움 스크린샷을 뜬다(RGB 전면판은 불투명 스크린샷,
// macOS·S0는 투명 바탕). 줄이기는 크로미움 이미지 보간(고품질)이 맡는다.

const sourceUrl = () => "data:image/png;base64," + readFileSync(SOURCE).toString("base64");

/** 원본 바탕색(네 모서리 평균). maskable 둘레를 채운다. */
function sourceBackground() {
  return "rgb(22 20 25)";
}

/** 판 종류별로 원본을 어디에 얼마나 크게 놓는가(캔버스 좌표). */
function placement(kind) {
  const { cx, cy, r } = SOURCE_BADGE;
  switch (kind) {
    case "full":
      return { canvas: 1024, x: 0, y: 0, size: 1024 };
    case "macos":
      return { canvas: 1024, x: MACOS.inset, y: MACOS.inset, size: MACOS.side, radius: MACOS.radius };
    case "maskable": {
      // 배지 원이 안전 원 안에 들게 줄이고, 원 중심을 캔버스 중심에.
      const k = (512 * SAFE_RADIUS) / r;
      return { canvas: 512, x: 256 - cx * k, y: 256 - cy * k, size: SOURCE_SIZE * k, fill: sourceBackground() };
    }
    case "badge": {
      // 배지 원 하나를 캔버스에 꽉 차게. 원 밖은 투명.
      const k = S0_SIZE / (2 * r);
      return { canvas: S0_SIZE, x: -(cx - r) * k, y: -(cy - r) * k, size: SOURCE_SIZE * k, circle: true };
    }
    default:
      throw new Error(kind);
  }
}

async function renderFromSource(page, kind, out) {
  const p = placement(kind);
  const clip = p.circle
    ? `border-radius:50%;`
    : p.radius
      ? `border-radius:${p.radius}px;`
      : "";
  // 잘라 내는 창(판·원)과 그 안의 원본 위치.
  const frame =
    kind === "macos"
      ? { left: p.x, top: p.y, w: p.size, h: p.size, img: { left: 0, top: 0, size: p.size } }
      : kind === "badge"
        ? { left: 0, top: 0, w: p.canvas, h: p.canvas, img: { left: p.x, top: p.y, size: p.size } }
        : { left: 0, top: 0, w: p.canvas, h: p.canvas, img: { left: p.x, top: p.y, size: p.size } };
  const transparent = kind === "macos" || kind === "badge";
  await page.setViewportSize({ width: out ?? p.canvas, height: out ?? p.canvas });
  const scale = (out ?? p.canvas) / p.canvas;
  await page.setContent(
    `<!doctype html><html><head><style>
       html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:${p.fill ?? "transparent"}}
       .frame{position:absolute;overflow:hidden;${clip}}
       img{position:absolute;display:block}
     </style></head><body>
     <div class="frame" style="left:${frame.left * scale}px;top:${frame.top * scale}px;width:${frame.w * scale}px;height:${frame.h * scale}px">
       <img src="${sourceUrl()}" style="left:${frame.img.left * scale}px;top:${frame.img.top * scale}px;width:${frame.img.size * scale}px;height:${frame.img.size * scale}px">
     </div></body></html>`,
    { waitUntil: "load" }
  );
  return withSrgb(await page.screenshot({ type: "png", omitBackground: transparent }));
}

/**
 * 파생 검사. 떠낸 PNG를 디코드하고, 원본을 같은 자리·같은 크기로 캔버스에 따로
 * 그려(쌍선형과 다른 경로) 픽셀을 비교한다. 알파가 0인 자리(판 밖·원 밖)는 뺀다.
 */
async function derivedDiff(page, path, kind) {
  const png = readFileSync(path);
  const size = png.readUInt32BE(16);
  const p = placement(kind);
  const k = size / p.canvas;
  return page.evaluate(
    async ({ b64, src, size, k, p, kind, macos }) => {
      const load = (url) =>
        new Promise((ok, no) => {
          const img = new Image();
          img.onload = () => ok(img);
          img.onerror = no;
          img.src = url;
        });
      const [out, ref] = [await load("data:image/png;base64," + b64), await load(src)];
      const c1 = document.createElement("canvas");
      c1.width = c1.height = size;
      const a = c1.getContext("2d");
      a.drawImage(out, 0, 0);
      const c2 = document.createElement("canvas");
      c2.width = c2.height = size;
      const b = c2.getContext("2d");
      b.imageSmoothingEnabled = true;
      b.imageSmoothingQuality = "high";
      if (p.fill) {
        b.fillStyle = p.fill;
        b.fillRect(0, 0, size, size);
      }
      b.drawImage(ref, p.x * k, p.y * k, p.size * k, p.size * k);
      const A = a.getImageData(0, 0, size, size).data;
      const B = b.getImageData(0, 0, size, size).data;
      let sum = 0;
      let n = 0;
      let over = 0;
      const inside = (x, y) => {
        if (kind === "badge") return Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size / 2 - 2;
        if (kind === "macos") {
          const lo = (macos.inset + macos.radius) * k;
          const hi = (macos.inset + macos.side - macos.radius) * k;
          const inX = x >= macos.inset * k + 2 && x < (macos.inset + macos.side) * k - 2;
          const inY = y >= macos.inset * k + 2 && y < (macos.inset + macos.side) * k - 2;
          return inX && inY && ((x > lo && x < hi) || (y > lo && y < hi));
        }
        return true;
      };
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          if (!inside(x, y)) continue;
          const i = (y * size + x) * 4;
          const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
          sum += (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
          if (d > 16) over++;
          n++;
        }
      return { mean: sum / n, over: over / n, n };
    },
    { b64: png.toString("base64"), src: sourceUrl(), size, k, p, kind, macos: MACOS }
  );
}

// ---- C2-04 틈 (#2650) --------------------------------------------------------

async function measureGaps(page) {
  const small = PARAMS.small;
  const smallGeo = buildMark(small);
  const S = [small.cx + small.sat, small.cy - small.sat];
  const toC = [small.cx - S[0], small.cy - S[1]];
  const d = Math.hypot(...toC);
  const gapMid = [S[0] + (toC[0] / d) * (small.s + small.g / 2), S[1] + (toC[1] / d) * (small.s + small.g / 2)];
  const ringMidDist = small.r + smallGeo.dims.biteRemainder / 2;
  const ringMid = [small.cx - (toC[0] / d) * ringMidDist, small.cy - (toC[1] / d) * ringMidDist];
  const favSrc = svg(FAVICON);
  const [, fvx, fvy, fvk] = favSrc
    .match(/<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)"/)
    .map(Number);
  const inFav = ([x, y]) => [fvx + fvk * x, fvy + fvk * y];
  await page.setContent("<!doctype html><html><body></body></html>");
  return page.evaluate(
    async ({ smallSrc, favSrc, favGap, favRing, gapMid, ringMid, grid }) => {
      const load = (src) =>
        new Promise((ok, no) => {
          const img = new Image();
          img.onload = () => ok(img);
          img.onerror = no;
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src);
        });
      const draw = async (src, size, bg) => {
        const img = await load(src);
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const ctx = c.getContext("2d");
        if (bg) {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, size, size);
        }
        ctx.drawImage(img, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size);
      };
      const inkAt = (data, x, y) => 1 - data.data[(Math.floor(y) * data.width + Math.floor(x)) * 4] / 255;
      const gaps = {};
      for (const size of [16, 24, 32]) {
        const s = await draw(smallSrc, size, "#ffffff");
        const k = size / grid;
        gaps[size] = {
          small: { gap: inkAt(s, gapMid[0] * k, gapMid[1] * k), ring: inkAt(s, ringMid[0] * k, ringMid[1] * k) },
        };
        const f = await draw(favSrc, size, null);
        const kf = size / 32;
        const g = (x, y) => f.data[(Math.floor(y) * f.width + Math.floor(x)) * 4 + 1] / 255;
        const tile = g(size / 2, 1);
        const paper = g(favRing[0] * kf, favRing[1] * kf);
        gaps[size].favicon = {
          gap: (g(favGap[0] * kf, favGap[1] * kf) - tile) / (0.965 - tile),
          ring: (paper - tile) / (0.965 - tile),
        };
      }
      return gaps;
    },
    { smallSrc: svg(SMALL), favSrc, favGap: inFav(gapMid), favRing: inFav(ringMid), gapMid, ringMid, grid: small.grid }
  );
}

// ---- 알파·도달 거리 ------------------------------------------------------------

async function pixelFacts(page) {
  const b64 = (p) => readFileSync(p).toString("base64");
  return page.evaluate(
    async ({ mac, badge, mask }) => {
      const decode = (data, size) =>
        new Promise((ok) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = c.height = size;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            ok(ctx.getImageData(0, 0, size, size));
          };
          img.src = "data:image/png;base64," + data;
        });
      const m = await decode(mac, 1024);
      const a = (d, x, y) => d.data[(y * d.width + x) * 4 + 3];
      const b = await decode(badge, 576);
      const k = await decode(mask, 512);
      const [r0, g0, b0] = [k.data[0], k.data[1], k.data[2]];
      let reach = 0;
      for (let y = 0; y < 512; y++)
        for (let x = 0; x < 512; x++) {
          const i = (y * 512 + x) * 4;
          if (Math.abs(k.data[i] - r0) + Math.abs(k.data[i + 1] - g0) + Math.abs(k.data[i + 2] - b0) > 24)
            reach = Math.max(reach, Math.hypot(x + 0.5 - 256, y + 0.5 - 256));
        }
      return {
        macos: { corner: a(m, 2, 2), outside: a(m, 60, 512), gridEdge: a(m, 102, 512), center: a(m, 512, 512) },
        badge: { corner: a(b, 3, 3), edgeOut: a(b, 40, 40), center: a(b, 288, 288) },
        reach: reach / 512,
      };
    },
    { mac: b64(resolve(TAURI_DIR, "app-icon.png")), badge: b64(S0_BADGE), mask: b64(resolve(PUBLIC_DIR, "icon-maskable-512.png")) }
  );
}

// ---- icns ------------------------------------------------------------------

async function shootSvg(page, source, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><style>
       html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
       svg{display:block;width:100%;height:100%}
     </style></head><body>${source}</body></html>`,
    { waitUntil: "load" }
  );
  return withSrgb(await page.screenshot({ type: "png", omitBackground: true }));
}

/** icns를 풀어 32px 이하 세 칸을 favicon.svg 렌더로 바꾸고 다시 묶는다. */
async function patchIcnsSmallSlots(page) {
  const icns = resolve(TAURI_DIR, "icons/icon.icns");
  const work = mkdtempSync(join(tmpdir(), "oort-icns-"));
  const set = join(work, "icon.iconset");
  try {
    execFileSync("iconutil", ["-c", "iconset", icns, "-o", set]);
    for (const [slot, px] of ICNS_TILE_SLOTS) writeFileSync(join(set, slot), await shootSvg(page, svg(FAVICON), px));
    execFileSync("iconutil", ["-c", "icns", set, "-o", icns]);
    console.log(`patched ${rel(icns)} (${ICNS_TILE_SLOTS.map(([s]) => s).join(", ")} = C2-04 small 타일)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** icns의 작은 칸들이 C2-04 small 타일인지: 파비콘 렌더와의 평균 차가 작고, macOS
 *  캐릭터판을 같은 크기로 줄인 것과의 평균 차보다 확실히 작아야 한다. */
async function checkIcnsSmallSlots(page) {
  const icns = resolve(TAURI_DIR, "icons/icon.icns");
  const work = mkdtempSync(join(tmpdir(), "oort-icns-"));
  const set = join(work, "icon.iconset");
  const out = {};
  try {
    execFileSync("iconutil", ["-c", "iconset", icns, "-o", set]);
    for (const [name, px] of ICNS_TILE_SLOTS) {
      const buf = readFileSync(join(set, name));
      if (buf.readUInt32BE(16) !== px) fail(`icon.icns ${name}의 폭이 ${buf.readUInt32BE(16)}, 기대 ${px}`);
      const fav = (await shootSvg(page, svg(FAVICON), px)).toString("base64");
      const mac = (await renderFromSource(page, "macos", px)).toString("base64");
      const diff = await page.evaluate(
        async ({ slot, fav, mac, px }) => {
          const decode = (b64) =>
            new Promise((ok) => {
              const img = new Image();
              img.onload = () => {
                const c = document.createElement("canvas");
                c.width = c.height = px;
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0, px, px);
                ok(ctx.getImageData(0, 0, px, px).data);
              };
              img.src = "data:image/png;base64," + b64;
            });
          const [a, f, m] = [await decode(slot), await decode(fav), await decode(mac)];
          const mad = (x, y) => {
            let s = 0;
            for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
            return s / x.length;
          };
          return { favicon: mad(a, f), character: mad(a, m) };
        },
        { slot: buf.toString("base64"), fav, mac, px }
      );
      if (!(diff.favicon < 4 && diff.favicon * 3 < diff.character))
        fail(`icon.icns ${name}이 C2-04 small 타일이 아니다 (파비콘과 ${diff.favicon.toFixed(1)}, 코메토와 ${diff.character.toFixed(1)})`);
      out[name] = diff;
    }
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- main ------------------------------------------------------------------

const CHARACTER_OUTPUTS = [
  [IOS_ICON, "full", 1024, { rgb: true }],
  [resolve(PUBLIC_DIR, "apple-touch-icon.png"), "full", 180, { rgb: true }],
  [resolve(PUBLIC_DIR, "icon-192.png"), "full", 192, { rgb: true }],
  [resolve(PUBLIC_DIR, "icon-512.png"), "full", 512, { rgb: true }],
  [resolve(PUBLIC_DIR, "icon-maskable-512.png"), "maskable", 512, { rgb: true }],
  [resolve(TAURI_DIR, "app-icon.png"), "macos", 1024, { rgb: false }],
  [S0_BADGE, "badge", S0_SIZE, { rgb: false }],
];

async function main() {
  const checkOnly = process.argv.includes("--check-only");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    const sha = createHash("sha256").update(readFileSync(SOURCE)).digest("hex");
    if (sha !== SOURCE_SHA256) fail(`${rel(SOURCE)}: sha256 ${sha} ≠ 고정값 ${SOURCE_SHA256} (owner 레퍼런스가 아니다)`);

    if (!checkOnly) {
      mkdirSync(dirname(S0_BADGE), { recursive: true });
      for (const [path, kind, size] of CHARACTER_OUTPUTS) {
        writeFileSync(path, await renderFromSource(page, kind, size));
        console.log(`wrote ${rel(path)}`);
      }
      writeFileSync(resolve(PUBLIC_DIR, "favicon-32.png"), await shootSvg(page, svg(FAVICON), 32));
      console.log(`wrote ${rel(resolve(PUBLIC_DIR, "favicon-32.png"))}`);
      execFileSync("cargo", ["tauri", "icon", "app-icon.png"], { cwd: TAURI_DIR, stdio: "inherit" });
      await patchIcnsSmallSlots(page);
    }

    // ---- 검사 ----
    const results = [];
    for (const [path, , size, spec] of CHARACTER_OUTPUTS) results.push([rel(path), checkPng(path, { size, ...spec })]);
    results.push([rel(resolve(PUBLIC_DIR, "favicon-32.png")), checkPng(resolve(PUBLIC_DIR, "favicon-32.png"), { size: 32, rgb: false })]);

    const derived = [];
    for (const [path, kind] of CHARACTER_OUTPUTS) {
      const d = await derivedDiff(page, path, kind);
      if (!(d.mean <= DERIVED.meanMax && d.over <= DERIVED.overMax))
        fail(`${rel(path)}: 레퍼런스에서 파생되지 않았다 (평균 차 ${d.mean.toFixed(2)}, 16 초과 ${(d.over * 100).toFixed(2)}%)`);
      derived.push([rel(path), kind, d]);
    }

    const facts = await pixelFacts(page);
    const mf = facts.macos;
    if (mf.corner !== 0 || mf.outside !== 0) fail(`app-icon.png: 여백이 투명하지 않다 ${JSON.stringify(mf)}`);
    if (mf.center !== 255 || mf.gridEdge !== 255) fail(`app-icon.png: 판이 불투명하지 않다 ${JSON.stringify(mf)}`);
    const bf = facts.badge;
    if (bf.corner !== 0 || bf.edgeOut !== 0 || bf.center !== 255) fail(`kometto-badge.png: 원 밖이 투명하지 않거나 가운데가 비었다 ${JSON.stringify(bf)}`);
    if (facts.reach > SAFE_RADIUS + 0.005) fail(`maskable: 배지가 안전 원 밖까지 간다 (${facts.reach.toFixed(3)} > ${SAFE_RADIUS})`);

    for (const [name, size] of [
      ["32x32.png", 32],
      ["64x64.png", 64],
      ["128x128.png", 128],
      ["128x128@2x.png", 256],
      ["icon.png", 512],
    ]) {
      const png = readFileSync(resolve(TAURI_DIR, "icons", name));
      if (png.readUInt32BE(16) !== size) fail(`icons/${name}: 폭 ${png.readUInt32BE(16)}, 기대 ${size}`);
    }
    const icns = readFileSync(resolve(TAURI_DIR, "icons/icon.icns"));
    if (icns.toString("latin1", 0, 4) !== "icns") fail("icons/icon.icns: icns 헤더가 아니다");
    const icnsSlots = await checkIcnsSmallSlots(page);

    const contrasts = MARK_PAIRS.map(([name, a, b]) => {
      const ratio = contrast(a, b);
      if (ratio < 3) fail(`대비 ${name}: ${ratio.toFixed(2)}:1 < 3:1`);
      return [name, `${a} / ${b}`, ratio.toFixed(2)];
    });
    const gaps = await measureGaps(page);
    for (const [size, g] of Object.entries(gaps)) {
      if (!(g.small.gap < 0.5 && g.small.ring - g.small.gap > 0.35))
        fail(`small ${size}px: 틈이 뭉개진다 (틈 ${g.small.gap.toFixed(2)}, 링 ${g.small.ring.toFixed(2)})`);
      if (!(g.favicon.gap < 0.5 && g.favicon.ring - g.favicon.gap > 0.35))
        fail(`favicon.svg ${size}px: 틈이 뭉개진다 (틈 ${g.favicon.gap.toFixed(2)}, 링 ${g.favicon.ring.toFixed(2)})`);
    }

    console.log(`\n== 레퍼런스 ${rel(SOURCE)}  sha256 ${sha.slice(0, 16)}…`);
    console.log("\n== PNG");
    for (const [path, r] of results) console.log(`${path}  ${r.w}x${r.h}  색유형 ${r.colorType}  sRGB ${r.srgb ? "o" : "x"}`);
    console.log(`app-icon.png 알파: ${JSON.stringify(mf)}   kometto-badge.png 알파: ${JSON.stringify(bf)}`);
    console.log(`\n== 레퍼런스 파생 (평균 차 ≤ ${DERIVED.meanMax}, 16 초과 ≤ ${DERIVED.overMax * 100}%)`);
    for (const [path, kind, d] of derived)
      console.log(`${path}  [${kind}]  평균 차 ${d.mean.toFixed(2)}  16 초과 ${(d.over * 100).toFixed(2)}%`);
    for (const [name, d] of Object.entries(icnsSlots))
      console.log(`icon.icns ${name} 평균 차: 파비콘 ${d.favicon.toFixed(1)} / 코메토 ${d.character.toFixed(1)}`);
    console.log("\n== C2-04 대비 (WCAG 1.4.11, 3:1 이상)");
    for (const [name, pair, ratio] of contrasts) console.log(`${name}  ${pair}  ${ratio}:1`);
    console.log("\n== C2-04 틈 가운데 잉크 비율 (0=바탕, 1=잉크)");
    for (const [size, g] of Object.entries(gaps))
      console.log(
        `${size}px  small 틈 ${g.small.gap.toFixed(2)} / 링 ${g.small.ring.toFixed(2)}   favicon 틈 ${g.favicon.gap.toFixed(2)} / 링 ${g.favicon.ring.toFixed(2)}`
      );
    console.log(`\n== maskable 도달 거리 ${facts.reach.toFixed(3)} (안전 ${SAFE_RADIUS})`);
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error("\nFAIL\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log("\nOK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
