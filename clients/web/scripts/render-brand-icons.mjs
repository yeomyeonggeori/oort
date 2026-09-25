#!/usr/bin/env node
// =============================================================================
// oort 앱 아이콘·파비콘의 모든 래스터를 SVG 정본에서 떠내고 검사한다
// (#2650 C2-04 마크, #2732 코메토 K6 얼굴).
//
//   npm run icons:brand           -> brand-mark.mjs로 SVG를 다시 쓴 뒤 이 파일
//   node scripts/render-brand-icons.mjs --check-only
//                                 -> 다시 뜨지 않고 커밋된 래스터만 검사
//   node scripts/render-brand-icons.mjs --candidates <dir>
//                                 -> 앱 아이콘 바탕 후보 세 장(dawn·ink·paper)과
//                                    후보별 대비표만 <dir>에 쓴다. 커밋하지 않는다.
//
// 입력은 docs/brand/mark/의 SVG와 public/favicon.svg뿐이다. 새 그림을 그리지
// 않는다. 떠내는 것:
//
//   웹    public/favicon-32.png        탭(SVG를 못 읽는 브라우저용). C2-04 small 타일
//         public/apple-touch-icon.png  180, iOS 홈 화면(웹), 코메토 전면판
//         public/icon-192.png          PWA any, 코메토 전면판
//         public/icon-512.png          PWA any, 코메토 전면판
//         public/icon-maskable-512.png PWA maskable, 코메토를 안전 원 안으로
//   데스크탑 clients/desktop/src-tauri/app-icon.png  1024 RGBA, macOS 그리드판
//         → `cargo tauri icon app-icon.png`가 icons/*(icns·ico 포함)를 만든다
//         → icns의 16px 칸만 C2-04 small 타일(favicon.svg)로 바꿔 끼운다(iconutil)
//   폰    clients/mobile/ios/.../AppIcon-1024.png   1024 RGB 불투명, 코메토 전면판
//
// 작은 크기 전략(#2732): 코메토 얼굴은 32px 이상에서만 쓴다. 32px 미만에서는
// 눈과 말풍선 꼬리가 뭉개진다(아래 「판독」 검사가 그 선을 잰다). 그 크기의
// 자리(탭 파비콘 16, icns 16)는 C2-04 small 단색 마크 타일이 맡는다. 얼굴 창의
// 림이 곧 C2-04 링이라 크기가 바뀌어도 같은 기하가 보인다.
//
// 검사(하나라도 어기면 exit 1):
//   - 크기: 모든 PNG의 IHDR 폭·높이가 요구한 값
//   - 알파: iOS 1024와 웹 전면판은 색 유형 2(RGB)이고 tRNS가 없다. macOS판은
//     RGBA이고, 모서리 밖은 투명(알파 0), 중심은 불투명
//   - sRGB: 떠낸 PNG마다 sRGB 청크가 있다(#2650 N-3)
//   - 대비(WCAG 1.4.11, 3:1): 캐릭터 색끼리(림/얼굴, 눈/얼굴)와, 바탕에 닿는 색
//     (후드·구슬·말풍선 꼬리)을 바탕 그라데이션의 **모든 멈춤점**과 잰다. 1024
//     렌더의 실제 픽셀로도 다시 잰다. 림/후드는 재기만 하고 기준을 걸지 않는다
//     (README 「대비」: 림은 얼굴과의 경계로 읽힌다)
//   - 색: 1024 렌더의 표본점(얼굴·눈·림·후드·구슬)이 정해진 색 그대로다
//   - 판독: 코메토 전면판을 여러 크기로 그린 뒤 다시 키워, 눈·눈 사이·말풍선
//     꼬리 자리의 밝기가 제 색 쪽인지 잰다. 32px 이상 나가는 크기에서 모두 0.5 이상
//   - 틈: C2-04 small 기하와 실제 파비콘 타일을 16·24·32px로 그렸을 때 위성과 링
//     사이 틈 한가운데 픽셀이 바탕 쪽에 가깝다
//   - icns 16px 칸이 C2-04 small 타일이다(코메토가 아니다)
//   - maskable: 가장 먼 픽셀이 지름 80% 안전 원 안에 있다
// =============================================================================

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { chromium } from "playwright";
import {
  APP_BACKGROUND,
  BACKGROUNDS,
  CHARACTER_COLORS,
  COLORS,
  PARAMS,
  SAFE_RADIUS,
  appIconPlacement,
  appIconSvg,
  buildMark,
} from "./brand-mark.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const MARK_DIR = resolve(REPO_ROOT, "docs/brand/mark");
const PUBLIC_DIR = resolve(WEB_ROOT, "public");
const TAURI_DIR = resolve(REPO_ROOT, "clients/desktop/src-tauri");
const IOS_ICON = resolve(
  REPO_ROOT,
  "clients/mobile/ios/MomoMobile/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png"
);

const svg = (path) => readFileSync(path, "utf8");
const FULL = resolve(MARK_DIR, "oort-app-icon.svg");
const MACOS = resolve(MARK_DIR, "oort-app-icon-macos.svg");
const FAVICON = resolve(PUBLIC_DIR, "favicon.svg");
const SMALL = resolve(MARK_DIR, "oort-mark-small-black.svg");

/** 코메토 얼굴을 쓰는 가장 작은 크기(px). 이보다 작은 자리는 C2-04 small 타일. */
export const CHARACTER_MIN_PX = 32;
/** 코메토 전면판이 실제로 나가는 크기들. iOS는 1024 한 장에서 시스템이 줄인다
 *  (설정 29pt·Spotlight 40pt·홈 60pt의 2x/3x). macOS는 icns 16@2x부터 512@2x. */
const SHIPPED_CHARACTER_PX = [32, 40, 58, 60, 64, 80, 87, 120, 128, 180, 192, 256, 512];
/** 문서용으로 함께 재는 작은 크기(검사 기준을 걸지 않는다: 여기서 무너진다). */
const PROBE_SMALL_PX = [16, 20, 24, 29];
/** 판독 기준. 0=둘레 색, 1=제 색. 표본점이 절반 이상 제 색 쪽이어야 읽힌다. */
const LEGIBLE = 0.5;

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

// ---- 대비 --------------------------------------------------------------------

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

/**
 * 캐릭터의 대비표. 바탕에 닿는 색은 바탕의 모든 멈춤점과 재고 가장 낮은 값을
 * 쓴다(선형 그라데이션의 휘도는 멈춤점 사이에서 단조라 최저는 멈춤점에 있다).
 * required=false인 행은 재기만 한다.
 */
function characterPairs(background) {
  const c = CHARACTER_COLORS;
  const stops = BACKGROUNDS[background].stops.map(([, hex]) => hex);
  const worst = (fg) => stops.reduce((m, bg) => Math.min(m, contrast(fg, bg)), Infinity);
  const worstStop = (fg) => stops.reduce((a, bg) => (contrast(fg, bg) < contrast(fg, a) ? bg : a));
  return [
    { name: "림 / 얼굴", pair: `${c.rim} / ${c.face}`, ratio: contrast(c.rim, c.face), required: true },
    { name: "눈 / 얼굴", pair: `${c.eye} / ${c.face}`, ratio: contrast(c.eye, c.face), required: true },
    { name: "후드 / 바탕(최저)", pair: `${c.hood} / ${worstStop(c.hood)}`, ratio: worst(c.hood), required: true },
    { name: "구슬 / 바탕(최저)", pair: `${c.bead} / ${worstStop(c.bead)}`, ratio: worst(c.bead), required: true },
    { name: "말풍선 꼬리 / 바탕(최저)", pair: `${c.rim} / ${worstStop(c.rim)}`, ratio: worst(c.rim), required: true },
    { name: "림 / 후드 (기준 없음)", pair: `${c.rim} / ${c.hood}`, ratio: contrast(c.rim, c.hood), required: false },
  ];
}

const MARK_PAIRS = [
  ["파비콘 링 / 타일", COLORS.paper, COLORS.ink],
  ["파비콘 위성 / 타일", COLORS.amber, COLORS.ink],
  ["단색 검정 / 흰 바탕", COLORS.ink, COLORS.white],
  ["단색 흰색 / 검정 바탕", COLORS.white, COLORS.ink],
  ["단색 호박 / 검정 바탕", COLORS.amber, COLORS.ink],
];

// ---- 렌더 --------------------------------------------------------------------

async function shoot(page, source, size, { transparent = false } = {}) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><style>
       html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
       svg{display:block;width:100%;height:100%}
     </style></head><body>${source}</body></html>`,
    { waitUntil: "load" }
  );
  return page.screenshot({ type: "png", omitBackground: transparent });
}

/** 전면판 1024 좌표계에서 캐릭터 표본점의 위치(캔버스 비, 0~1). */
function probesOn(frame) {
  const { ch, scale, tx, ty } = appIconPlacement(frame);
  return Object.fromEntries(
    Object.entries(ch.dims.probes).map(([k, [x, y]]) => [k, [(tx + scale * x) / 1024, (ty + scale * y) / 1024]])
  );
}

/**
 * 브라우저 안 캔버스로 픽셀을 잰다: 틈, 판독, 1024 표본 색, maskable 도달 거리.
 * 파일을 디코드할 라이브러리를 들이지 않으려고 크로미움에게 맡긴다.
 */
async function measure(page) {
  const small = PARAMS.small;
  const smallGeo = buildMark(small);
  // 틈 한가운데: 위성 중심에서 링 중심 쪽으로 s + g/2.
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

  const fullSrc = svg(FULL);
  // 바탕만 남긴 판: 판독 검사에서 표본점 자리의 「둘레 색」을 얻는다.
  const bgOnlySrc = fullSrc.replace(/<g transform="[^"]*">[\s\S]*?<\/g>/, "");

  await page.setContent("<!doctype html><html><body></body></html>");
  return page.evaluate(
    async ({ smallSrc, fullSrc, bgOnlySrc, maskSrc, favSrc, favGap, favRing, gapMid, ringMid, grid, probes, sizes, colors }) => {
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
        return { data: ctx.getImageData(0, 0, size, size), canvas: c };
      };
      const inkAt = (data, x, y) => {
        const i = (Math.floor(y) * data.width + Math.floor(x)) * 4;
        return 1 - data.data[i] / 255;
      };
      const hex = (data, x, y) => {
        const i = (Math.floor(y) * data.width + Math.floor(x)) * 4;
        return "#" + [0, 1, 2].map((o) => data.data[i + o].toString(16).padStart(2, "0")).join("");
      };
      const lin = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const lum = (data, x, y) => {
        const i = (Math.floor(y) * data.width + Math.floor(x)) * 4;
        return 0.2126 * lin(data.data[i]) + 0.7152 * lin(data.data[i + 1]) + 0.0722 * lin(data.data[i + 2]);
      };
      const lumHex = (h) => {
        const n = parseInt(h.slice(1), 16);
        return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
      };

      // ---- C2-04 small 틈 (#2650) ----
      const smallImg = smallSrc;
      const gaps = {};
      for (const size of [16, 24, 32]) {
        const { data: s } = await draw(smallImg, size, "#ffffff");
        const k = size / grid;
        gaps[size] = {
          small: { gap: inkAt(s, gapMid[0] * k, gapMid[1] * k), ring: inkAt(s, ringMid[0] * k, ringMid[1] * k) },
        };
        const { data: f } = await draw(favSrc, size, null);
        const kf = size / 32;
        const g = (x, y) => f.data[(Math.floor(y) * f.width + Math.floor(x)) * 4 + 1] / 255;
        const tile = g(size / 2, 1);
        const paper = g(favRing[0] * kf, favRing[1] * kf);
        gaps[size].favicon = {
          gap: (g(favGap[0] * kf, favGap[1] * kf) - tile) / (0.965 - tile),
          ring: (paper - tile) / (0.965 - tile),
        };
      }

      // ---- 코메토 판독 (#2732) ----
      // n px로 그린 뒤 1024로 부드럽게 다시 키워(쌍선형), 표본점의 밝기를 읽는다.
      // 픽셀 격자와 표본점이 어긋나는 운에 덜 흔들린다.
      const up = (canvas) => {
        const u = document.createElement("canvas");
        u.width = u.height = 1024;
        const ctx = u.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(canvas, 0, 0, 1024, 1024);
        return ctx.getImageData(0, 0, 1024, 1024);
      };
      const at = (data, p) => lum(data, p[0] * 1024, p[1] * 1024);
      const Lface = lumHex(colors.face);
      const Leye = lumHex(colors.eye);
      const Lrim = lumHex(colors.rim);
      const legibility = {};
      for (const size of sizes) {
        const d = up((await draw(fullSrc, size, null)).canvas);
        const b = up((await draw(bgOnlySrc, size, null)).canvas);
        const tailBg = at(b, probes.tail);
        legibility[size] = {
          // 눈 자리가 얼굴보다 눈 쪽이다
          eye: (at(d, probes.eye) - Lface) / (Leye - Lface),
          // 두 눈 사이가 얼굴색으로 남는다(두 점이 한 덩어리로 붙지 않는다)
          between: (Leye - at(d, probes.betweenEyes)) / (Leye - Lface),
          // 말풍선 꼬리 끝이 바탕보다 림 색 쪽이다
          tail: (at(d, probes.tail) - tailBg) / (Lrim - tailBg),
        };
      }

      // ---- 1024 전면판 표본 색 ----
      const { data: full } = await draw(fullSrc, 1024, null);
      const P = (p) => [p[0] * 1024, p[1] * 1024];
      const fullPixels = {
        corner: hex(full, 4, 4),
        bottom: hex(full, 512, 1019),
        face: hex(full, ...P(probes.face)),
        eye: hex(full, ...P(probes.eye)),
        rim: hex(full, ...P(probes.rim)),
        hood: hex(full, ...P(probes.hood)),
        bead: hex(full, ...P(probes.bead)),
        tail: hex(full, ...P(probes.tail)),
      };

      // ---- maskable 도달 거리 ----
      const { data: mask } = await draw(maskSrc, 512, null);
      const bgAt = (x, y) => {
        const i = (y * 512 + x) * 4;
        return [mask.data[i], mask.data[i + 1], mask.data[i + 2]];
      };
      let reach = 0;
      for (let y = 0; y < 512; y++) {
        // 그라데이션 바탕: 같은 줄의 가장 왼쪽 픽셀을 그 줄의 바탕색으로 본다.
        const [bgR, bgG, bgB] = bgAt(0, y);
        for (let x = 0; x < 512; x++) {
          const i = (y * 512 + x) * 4;
          const diff =
            Math.abs(mask.data[i] - bgR) + Math.abs(mask.data[i + 1] - bgG) + Math.abs(mask.data[i + 2] - bgB);
          if (diff > 24) reach = Math.max(reach, Math.hypot(x + 0.5 - 256, y + 0.5 - 256));
        }
      }
      return { gaps, legibility, fullPixels, reach: reach / 512 };
    },
    {
      smallSrc: svg(SMALL),
      fullSrc,
      bgOnlySrc,
      maskSrc: appIconSvg("maskable"),
      favSrc,
      favGap: inFav(gapMid),
      favRing: inFav(ringMid),
      gapMid,
      ringMid,
      grid: small.grid,
      probes: probesOn("full"),
      sizes: [...PROBE_SMALL_PX, ...SHIPPED_CHARACTER_PX],
      colors: CHARACTER_COLORS,
    }
  );
}

/** icns를 풀어 16px 칸을 favicon.svg 렌더로 바꾸고 다시 묶는다. */
async function patchIcnsSmallSlot(page) {
  const icns = resolve(TAURI_DIR, "icons/icon.icns");
  const work = mkdtempSync(join(tmpdir(), "oort-icns-"));
  const set = join(work, "icon.iconset");
  try {
    execFileSync("iconutil", ["-c", "iconset", icns, "-o", set]);
    writeFileSync(join(set, "icon_16x16.png"), withSrgb(await shoot(page, svg(FAVICON), 16, { transparent: true })));
    execFileSync("iconutil", ["-c", "icns", set, "-o", icns]);
    console.log(`patched ${rel(icns)} (16px 칸 = C2-04 small 타일)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** icns의 16px 칸이 C2-04 small 타일인지 본다: 파비콘 16 렌더와의 평균 차가 작고,
 *  코메토 전면판 16 렌더와의 평균 차보다 확실히 작아야 한다. */
async function checkIcnsSmallSlot(page) {
  const icns = resolve(TAURI_DIR, "icons/icon.icns");
  const work = mkdtempSync(join(tmpdir(), "oort-icns-"));
  const set = join(work, "icon.iconset");
  try {
    execFileSync("iconutil", ["-c", "iconset", icns, "-o", set]);
    const slot = readFileSync(join(set, "icon_16x16.png")).toString("base64");
    const w = readFileSync(join(set, "icon_16x16.png")).readUInt32BE(16);
    if (w !== 16) fail(`icon.icns 16px 칸의 폭이 ${w}`);
    const fav = (await shoot(page, svg(FAVICON), 16, { transparent: true })).toString("base64");
    const mac = (await shoot(page, svg(MACOS), 16, { transparent: true })).toString("base64");
    const diff = await page.evaluate(
      async ({ slot, fav, mac }) => {
        const decode = (b64) =>
          new Promise((ok) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement("canvas");
              c.width = c.height = 16;
              const ctx = c.getContext("2d");
              ctx.drawImage(img, 0, 0, 16, 16);
              ok(ctx.getImageData(0, 0, 16, 16).data);
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
      { slot, fav, mac }
    );
    if (!(diff.favicon < 4 && diff.favicon * 3 < diff.character))
      fail(`icon.icns 16px 칸이 C2-04 small 타일이 아니다 (파비콘과 ${diff.favicon.toFixed(1)}, 코메토와 ${diff.character.toFixed(1)})`);
    return diff;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function renderCandidates(page, dir) {
  mkdirSync(dir, { recursive: true });
  const lines = [];
  for (const name of Object.keys(BACKGROUNDS)) {
    const path = resolve(dir, `candidate-${name}.png`);
    writeFileSync(path, withSrgb(await shoot(page, appIconSvg("full", name), 1024)));
    const pairs = characterPairs(name);
    const verdict = pairs.every((p) => !p.required || p.ratio >= 3) ? "통과" : "탈락";
    lines.push(`\n== ${name}${name === APP_BACKGROUND ? " (권장)" : ""}: ${verdict}  ${path}`);
    for (const p of pairs)
      lines.push(`${p.name}  ${p.pair}  ${p.ratio.toFixed(2)}:1${p.required && p.ratio < 3 ? "  < 3:1" : ""}`);
  }
  console.log(lines.join("\n"));
}

async function main() {
  const checkOnly = process.argv.includes("--check-only");
  const candidatesAt = process.argv.indexOf("--candidates");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    if (candidatesAt > 0) {
      await renderCandidates(page, resolve(process.argv[candidatesAt + 1]));
      return;
    }
    if (!checkOnly) {
      const put = (path, buf) => {
        writeFileSync(path, withSrgb(buf));
        console.log(`wrote ${rel(path)}`);
      };
      put(resolve(PUBLIC_DIR, "favicon-32.png"), await shoot(page, svg(FAVICON), 32, { transparent: true }));
      put(resolve(PUBLIC_DIR, "apple-touch-icon.png"), await shoot(page, svg(FULL), 180));
      put(resolve(PUBLIC_DIR, "icon-192.png"), await shoot(page, svg(FULL), 192));
      put(resolve(PUBLIC_DIR, "icon-512.png"), await shoot(page, svg(FULL), 512));
      put(resolve(PUBLIC_DIR, "icon-maskable-512.png"), await shoot(page, appIconSvg("maskable"), 512));
      put(IOS_ICON, await shoot(page, svg(FULL), 1024));
      put(resolve(TAURI_DIR, "app-icon.png"), await shoot(page, svg(MACOS), 1024, { transparent: true }));
      // Tauri 아이콘 세트: 전 크기와 icns·ico를 app-icon.png 한 장에서.
      execFileSync("cargo", ["tauri", "icon", "app-icon.png"], { cwd: TAURI_DIR, stdio: "inherit" });
      await patchIcnsSmallSlot(page);
    }

    // ---- 검사 ----
    const results = [];
    const expect = [
      [resolve(PUBLIC_DIR, "favicon-32.png"), { size: 32, rgb: false }],
      [resolve(PUBLIC_DIR, "apple-touch-icon.png"), { size: 180, rgb: true }],
      [resolve(PUBLIC_DIR, "icon-192.png"), { size: 192, rgb: true }],
      [resolve(PUBLIC_DIR, "icon-512.png"), { size: 512, rgb: true }],
      [resolve(PUBLIC_DIR, "icon-maskable-512.png"), { size: 512, rgb: true }],
      [IOS_ICON, { size: 1024, rgb: true }],
      [resolve(TAURI_DIR, "app-icon.png"), { size: 1024, rgb: false }],
    ];
    for (const [path, spec] of expect) results.push([rel(path), checkPng(path, spec)]);

    // macOS판: 모서리 밖 투명, 중심 불투명.
    const mac = readFileSync(resolve(TAURI_DIR, "app-icon.png")).toString("base64");
    const alpha = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((ok) => {
        img.onload = ok;
        img.src = "data:image/png;base64," + b64;
      });
      const c = document.createElement("canvas");
      c.width = c.height = 1024;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const a = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
      return { corner: a(2, 2), gridEdge: a(100 + 2, 512), outside: a(60, 512), center: a(512, 512) };
    }, mac);
    if (alpha.corner !== 0 || alpha.outside !== 0) fail(`app-icon.png: 여백이 투명하지 않다 ${JSON.stringify(alpha)}`);
    if (alpha.center !== 255 || alpha.gridEdge !== 255) fail(`app-icon.png: 판이 불투명하지 않다 ${JSON.stringify(alpha)}`);

    // Tauri가 만든 데스크탑 세트의 크기
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
    const icnsSlot = await checkIcnsSmallSlot(page);

    // 대비: 캐릭터(권장 바탕) + C2-04 마크
    const contrasts = characterPairs(APP_BACKGROUND).map((p) => {
      if (p.required && p.ratio < 3) fail(`대비 ${p.name}: ${p.ratio.toFixed(2)}:1 < 3:1`);
      return [p.name, p.pair, p.ratio.toFixed(2)];
    });
    for (const [name, a, b] of MARK_PAIRS) {
      const ratio = contrast(a, b);
      if (ratio < 3) fail(`대비 ${name}: ${ratio.toFixed(2)}:1 < 3:1`);
      contrasts.push([name, `${a} / ${b}`, ratio.toFixed(2)]);
    }

    const m = await measure(page);
    const fp = m.fullPixels;
    const c = CHARACTER_COLORS;
    for (const [key, want] of [
      ["face", c.face],
      ["eye", c.eye],
      ["rim", c.rim],
      ["hood", c.hood],
      ["bead", c.bead],
      ["tail", c.rim],
    ])
      if (fp[key] !== want) fail(`전면판 ${key} 표본 픽셀 ${fp[key]} ≠ ${want}`);
    const stops = BACKGROUNDS[APP_BACKGROUND].stops;
    const near = (a, b) =>
      [0, 2, 4].every((i) => Math.abs(parseInt(a.slice(1 + i, 3 + i), 16) - parseInt(b.slice(1 + i, 3 + i), 16)) <= 2);
    if (!near(fp.corner, stops[0][1])) fail(`전면판 위 모서리 ${fp.corner} ≠ ${stops[0][1]}`);
    if (!near(fp.bottom, stops[stops.length - 1][1])) fail(`전면판 아래 끝 ${fp.bottom} ≠ ${stops[stops.length - 1][1]}`);
    const measured = [
      ["1024 렌더 림 / 얼굴", fp.rim, fp.face],
      ["1024 렌더 눈 / 얼굴", fp.eye, fp.face],
      ["1024 렌더 후드 / 아래 바탕", fp.hood, fp.bottom],
      ["1024 렌더 구슬 / 위 바탕", fp.bead, fp.corner],
      ["1024 렌더 꼬리 / 아래 바탕", fp.tail, fp.bottom],
    ].map(([name, a, b]) => {
      const ratio = contrast(a, b);
      if (ratio < 3) fail(`대비 ${name}: ${ratio.toFixed(2)}:1 < 3:1`);
      return [name, `${a} / ${b}`, ratio.toFixed(2)];
    });
    contrasts.push(...measured);

    for (const [size, g] of Object.entries(m.gaps)) {
      if (!(g.small.gap < 0.5 && g.small.ring - g.small.gap > 0.35))
        fail(`small ${size}px: 틈이 뭉개진다 (틈 ${g.small.gap.toFixed(2)}, 링 ${g.small.ring.toFixed(2)})`);
      if (!(g.favicon.gap < 0.5 && g.favicon.ring - g.favicon.gap > 0.35))
        fail(`favicon.svg ${size}px: 틈이 뭉개진다 (틈 ${g.favicon.gap.toFixed(2)}, 링 ${g.favicon.ring.toFixed(2)})`);
    }
    for (const size of SHIPPED_CHARACTER_PX) {
      const l = m.legibility[size];
      for (const [k, v] of Object.entries(l))
        if (!(v >= LEGIBLE)) fail(`코메토 ${size}px: ${k} ${v.toFixed(2)} < ${LEGIBLE} (얼굴이 뭉개진다)`);
    }
    if (m.reach > SAFE_RADIUS + 0.005) fail(`maskable: 얼굴이 안전 원 밖까지 간다 (${m.reach.toFixed(3)} > ${SAFE_RADIUS})`);

    console.log("\n== PNG");
    for (const [path, r] of results) console.log(`${path}  ${r.w}x${r.h}  색유형 ${r.colorType}  sRGB ${r.srgb ? "o" : "x"}`);
    console.log(`app-icon.png 알파: ${JSON.stringify(alpha)}`);
    console.log(
      `icon.icns 16px 칸 평균 차: 파비콘 ${icnsSlot.favicon.toFixed(1)} / 코메토 ${icnsSlot.character.toFixed(1)}`
    );
    console.log(`\n== 대비 (WCAG 1.4.11, 3:1 이상, 바탕 ${APP_BACKGROUND})`);
    for (const [name, pair, ratio] of contrasts) console.log(`${name}  ${pair}  ${ratio}:1`);
    console.log(`\n== 코메토 판독 (0=둘레 색, 1=제 색, ${CHARACTER_MIN_PX}px 이상에서 ${LEGIBLE} 이상)`);
    for (const [size, l] of Object.entries(m.legibility))
      console.log(
        `${String(size).padStart(4)}px  눈 ${l.eye.toFixed(2)}  눈 사이 ${l.between.toFixed(2)}  꼬리 ${l.tail.toFixed(2)}${
          Number(size) < CHARACTER_MIN_PX ? "  (C2-04 small 자리)" : ""
        }`
      );
    console.log("\n== C2-04 틈 가운데 잉크 비율 (0=바탕, 1=잉크)");
    for (const [size, g] of Object.entries(m.gaps))
      console.log(
        `${size}px  small 틈 ${g.small.gap.toFixed(2)} / 링 ${g.small.ring.toFixed(2)}   favicon 틈 ${g.favicon.gap.toFixed(2)} / 링 ${g.favicon.ring.toFixed(2)}`
      );
    console.log(`\n== maskable 도달 거리 ${m.reach.toFixed(3)} (안전 ${SAFE_RADIUS})`);
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
