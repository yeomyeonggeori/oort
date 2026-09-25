#!/usr/bin/env node
// =============================================================================
// oort 마크의 모든 래스터를 SVG 정본에서 떠내고 검사한다 (#2650).
//
//   npm run icons:brand           -> brand-mark.mjs로 SVG를 다시 쓴 뒤 이 파일
//   node scripts/render-brand-icons.mjs --check-only
//                                 -> 다시 뜨지 않고 커밋된 래스터만 검사
//
// 입력은 docs/brand/mark/의 SVG와 public/favicon.svg뿐이다. 새 그림을 그리지
// 않는다. 떠내는 것:
//
//   웹    public/favicon-32.png        탭(SVG를 못 읽는 브라우저용), favicon.svg에서
//         public/apple-touch-icon.png  180, iOS 홈 화면(웹), 전면판
//         public/icon-192.png          PWA any, 전면판
//         public/icon-512.png          PWA any, 전면판
//         public/icon-maskable-512.png PWA maskable, 마크를 안전 원 안으로
//   데스크탑 clients/desktop/src-tauri/app-icon.png  1024 RGBA, macOS 그리드판
//         → `cargo tauri icon app-icon.png`가 icons/*(icns·ico 포함)를 만든다
//   폰    clients/mobile/ios/.../AppIcon-1024.png   1024 RGB 불투명, 전면판
//
// 검사(하나라도 어기면 exit 1):
//   - 크기: 모든 PNG의 IHDR 폭·높이가 요구한 값
//   - 알파: iOS 1024와 웹 전면판은 색 유형 2(RGB)이고 tRNS가 없다. macOS판은
//     RGBA이고, 모서리 밖은 투명(알파 0), 중심은 불투명
//   - sRGB: 떠낸 PNG마다 sRGB 청크가 있다(#2650 N-3: 태그 없이 기본값에 기대지 않는다)
//   - 대비: 앱 아이콘 링·위성과 바탕의 비텍스트 대비 3:1 이상(WCAG 1.4.11). 값은
//     색 상수에서 계산하고, 1024 렌더의 실제 픽셀로도 다시 잰다
//   - 틈: small 기하를 16·24·32px로 그렸을 때 위성과 링 사이 틈 한가운데 픽셀이
//     바탕 쪽에 가깝다(뭉개지지 않는다)
//   - maskable: 마크의 가장 먼 픽셀이 지름 80% 안전 원 안에 있다
// =============================================================================

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { chromium } from "playwright";
import { APP_ICON, COLORS, PARAMS, buildMark } from "./brand-mark.mjs";

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

// 안전 영역은 지름 80%인 원(W3C maskable). 0.95는 반올림 여유.
const SAFE_RADIUS = 0.4 * 0.95;

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

const PAIRS = [
  ["앱 아이콘 링 / 바탕", COLORS.paper, COLORS.ink],
  ["앱 아이콘 위성 / 바탕", COLORS.amber, COLORS.ink],
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

/** maskable: 전면판의 마크를 안전 원 안으로 줄인다. 비율은 기하에서 계산한다. */
function maskableSvg() {
  const full = svg(FULL);
  const p = PARAMS.regular;
  const geo = buildMark(p);
  const bb = geo.dims.bbox;
  const cx = (bb.left + bb.right) / 2;
  const cy = (bb.top + bb.bottom) / 2;
  const far = geo.dims.reach;
  const side = Math.max(bb.right - bb.left, bb.bottom - bb.top);
  const reach = far / side; // 마크 한 변 대비 가장 먼 점의 거리
  const fill = Math.min(APP_ICON.markFill, SAFE_RADIUS / reach);
  return full.replace(
    /<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)"/,
    () => {
      const scale = (APP_ICON.canvas * fill) / side;
      const tx = APP_ICON.canvas / 2 - scale * cx;
      const ty = APP_ICON.canvas / 2 - scale * cy;
      return `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})"`;
    }
  );
}

/**
 * 브라우저 안 캔버스로 픽셀을 잰다: 틈 가운데 픽셀, 대비 표본, maskable 도달 거리.
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
  // 틈 양옆: 위성 안(중심)과 링 몸통(홈 바닥과 구멍 사이 가운데)
  const ringMidDist = small.r + smallGeo.dims.biteRemainder / 2;
  const ringMid = [small.cx - (toC[0] / d) * ringMidDist, small.cy - (toC[1] / d) * ringMidDist];

  const fullSrc = svg(FULL);
  const maskSrc = maskableSvg();
  const smallSrc = svg(SMALL);
  const regularSrc = svg(resolve(MARK_DIR, "oort-mark-black.svg"));
  const reg = PARAMS.regular;
  const R = [reg.cx + reg.sat, reg.cy - reg.sat];
  const toCR = [reg.cx - R[0], reg.cy - R[1]];
  const dR = Math.hypot(...toCR);
  // 전면판 SVG의 마크 변환을 읽어, 링 몸통(왼쪽 가운데)과 위성 중심의 픽셀 좌표를 얻는다.
  const [, ftx, fty, fk] = fullSrc.match(/translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/).map(Number);
  const toFull = ([x, y]) => [ftx + fk * x, fty + fk * y];
  const regGapMid = [R[0] + (toCR[0] / dR) * (reg.s + reg.g / 2), R[1] + (toCR[1] / dR) * (reg.s + reg.g / 2)];

  await page.setContent("<!doctype html><html><body></body></html>");
  return page.evaluate(
    async ({ smallSrc, regularSrc, fullSrc, maskSrc, gapMid, ringMid, regGapMid, grids, fullRing, fullSat }) => {
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
      // 단색 검정을 흰 바탕에: 0=바탕, 1=잉크 (반올림 없이 면적 평균인 안티앨리어싱값)
      const inkAt = (data, x, y) => {
        const i = (Math.floor(y) * data.width + Math.floor(x)) * 4;
        return 1 - data.data[i] / 255;
      };
      const gaps = {};
      for (const size of [16, 24, 32]) {
        const s = await draw(smallSrc, size, "#ffffff");
        const k = size / grids.small;
        const r = await draw(regularSrc, size, "#ffffff");
        const kr = size / grids.regular;
        gaps[size] = {
          small: {
            gap: inkAt(s, gapMid[0] * k, gapMid[1] * k),
            ring: inkAt(s, ringMid[0] * k, ringMid[1] * k),
          },
          regular: { gap: inkAt(r, regGapMid[0] * kr, regGapMid[1] * kr) },
        };
      }
      // 1024 전면판의 실제 픽셀: 바탕(모서리), 링(왼쪽 가운데 몸통), 위성 중심
      const full = await draw(fullSrc, 1024, null);
      const px = (x, y) => {
        const i = (y * 1024 + x) * 4;
        return (
          "#" +
          [0, 1, 2].map((o) => full.data[i + o].toString(16).padStart(2, "0")).join("")
        );
      };
      // maskable 도달 거리: 바탕과 다른 픽셀 중 중심에서 가장 먼 것
      const mask = await draw(maskSrc, 512, null);
      const bgR = mask.data[0], bgG = mask.data[1], bgB = mask.data[2];
      let reach = 0;
      for (let y = 0; y < 512; y++)
        for (let x = 0; x < 512; x++) {
          const i = (y * 512 + x) * 4;
          const diff =
            Math.abs(mask.data[i] - bgR) + Math.abs(mask.data[i + 1] - bgG) + Math.abs(mask.data[i + 2] - bgB);
          if (diff > 24) reach = Math.max(reach, Math.hypot(x + 0.5 - 256, y + 0.5 - 256));
        }
      return {
        gaps,
        fullPixels: {
          corner: px(4, 4),
          ring: px(Math.round(fullRing[0]), Math.round(fullRing[1])),
          satellite: px(Math.round(fullSat[0]), Math.round(fullSat[1])),
        },
        reach: reach / 512,
      };
    },
    {
      smallSrc,
      regularSrc,
      fullSrc,
      maskSrc,
      gapMid,
      ringMid,
      regGapMid,
      grids: { small: small.grid, regular: reg.grid },
      fullRing: toFull([reg.cx - (reg.R + reg.r) / 2, reg.cy]),
      fullSat: toFull(R),
    }
  );
}

async function main() {
  const checkOnly = process.argv.includes("--check-only");
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    if (!checkOnly) {
      const put = (path, buf) => {
        writeFileSync(path, withSrgb(buf));
        console.log(`wrote ${rel(path)}`);
      };
      put(resolve(PUBLIC_DIR, "favicon-32.png"), await shoot(page, svg(FAVICON), 32, { transparent: true }));
      put(resolve(PUBLIC_DIR, "apple-touch-icon.png"), await shoot(page, svg(FULL), 180));
      put(resolve(PUBLIC_DIR, "icon-192.png"), await shoot(page, svg(FULL), 192));
      put(resolve(PUBLIC_DIR, "icon-512.png"), await shoot(page, svg(FULL), 512));
      put(resolve(PUBLIC_DIR, "icon-maskable-512.png"), await shoot(page, maskableSvg(), 512));
      put(IOS_ICON, await shoot(page, svg(FULL), 1024));
      put(resolve(TAURI_DIR, "app-icon.png"), await shoot(page, svg(MACOS), 1024, { transparent: true }));
      // Tauri 아이콘 세트: 전 크기와 icns·ico를 app-icon.png 한 장에서.
      execFileSync("cargo", ["tauri", "icon", "app-icon.png"], { cwd: TAURI_DIR, stdio: "inherit" });
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

    // macOS판: 모서리 밖 투명, 중심 불투명. 브라우저로 픽셀을 읽는다.
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

    // 대비
    const contrasts = PAIRS.map(([name, a, b]) => {
      const ratio = contrast(a, b);
      if (ratio < 3) fail(`대비 ${name}: ${ratio.toFixed(2)}:1 < 3:1`);
      return [name, `${a} / ${b}`, ratio.toFixed(2)];
    });

    const m = await measure(page);
    const fp = m.fullPixels;
    if (fp.corner !== COLORS.ink) fail(`전면판 바탕 픽셀 ${fp.corner} ≠ ${COLORS.ink}`);
    if (fp.ring !== COLORS.paper) fail(`전면판 링 픽셀 ${fp.ring} ≠ ${COLORS.paper}`);
    if (fp.satellite !== COLORS.amber) fail(`전면판 위성 픽셀 ${fp.satellite} ≠ ${COLORS.amber}`);
    const measured = [
      ["1024 렌더 링 / 바탕", fp.ring, fp.corner],
      ["1024 렌더 위성 / 바탕", fp.satellite, fp.corner],
    ].map(([name, a, b]) => {
      const ratio = contrast(a, b);
      if (ratio < 3) fail(`대비 ${name}: ${ratio.toFixed(2)}:1 < 3:1`);
      return [name, `${a} / ${b}`, ratio.toFixed(2)];
    });
    contrasts.push(...measured);
    for (const [size, g] of Object.entries(m.gaps)) {
      // 틈 가운데가 잉크 절반 미만이고 링 몸통보다 확실히 옅어야 틈이 보인다.
      if (!(g.small.gap < 0.5 && g.small.ring - g.small.gap > 0.35))
        fail(`small ${size}px: 틈이 뭉개진다 (틈 ${g.small.gap.toFixed(2)}, 링 ${g.small.ring.toFixed(2)})`);
    }
    if (m.reach > SAFE_RADIUS + 0.005) fail(`maskable: 마크가 안전 원 밖까지 간다 (${m.reach.toFixed(3)} > ${SAFE_RADIUS})`);

    console.log("\n== PNG");
    for (const [path, r] of results) console.log(`${path}  ${r.w}x${r.h}  색유형 ${r.colorType}  sRGB ${r.srgb ? "o" : "x"}`);
    console.log(`app-icon.png 알파: ${JSON.stringify(alpha)}`);
    console.log("\n== 대비 (WCAG 1.4.11, 3:1 이상)");
    for (const [name, pair, ratio] of contrasts) console.log(`${name}  ${pair}  ${ratio}:1`);
    console.log("\n== 틈 가운데 잉크 비율 (0=바탕, 1=잉크)");
    for (const [size, g] of Object.entries(m.gaps))
      console.log(
        `${size}px  small 틈 ${g.small.gap.toFixed(2)} / 링 ${g.small.ring.toFixed(2)}   regular 틈 ${g.regular.gap.toFixed(2)}`
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
