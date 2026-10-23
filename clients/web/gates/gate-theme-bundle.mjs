#!/usr/bin/env node
// =============================================================================
// GATE — 테마 번들 예산 (ADR-0189 증보 3 D1·D2, AP-1b #4188, AC 5).
//
// 카탈로그(57종 씨앗 표)와 파생 엔진은 **메인 번들에 들어가지 않는다**. 갤러리·강조색 칩·적용기가 지연 청크로 싣고,
// 메인 번들은 얇은 문(`applyDerived.ts`)과 카탈로그 색인(한 줄 문자열, 원문 약 0.6KB)만 든다. 이 게이트가 그 경계를
// 배포되는 `dist`에서 잰다. 단위 시험은 파일과 함수를 재지만, 누가 엔진을 정적으로 가져오는 한 줄은 어느 단위도
// 틀리지 않은 채 메인 번들만 키운다.
//
//   1. 구조(드리프트 없음). 표식 문자열 넷이 부트 그래프(진입 청크와 그것이 **정적으로** 가져오는 청크 전부)에 없고,
//      지연 청크 어딘가에는 모두 있다. 표식은 엔진·카탈로그·갤러리·칩 각각에만 있는 문자열 리터럴이다(압축해도
//      리터럴은 남는다). 지연 쪽에서 하나라도 못 찾으면 실패한다: 표식이 바뀌었는데 게이트가 헛도는 것을 막는다.
//   2. 크기. 테마 지연 청크(표식이 든 부트 밖 청크)의 gzip 합 ≤ 25 KB.
//   3. 메인 증가. `BASE_DIST=<기준 dist>`를 주면 기준과 **같은 베이스**에서 빌드한 두 번들의 메인(진입) 청크 gzip
//      차이를 재서 ≤ 2 KB를 단정한다. 기준 없이 도는 실행은 증가를 단정하지 않고 절대 크기만 적는다: 고정 기준값은
//      무관한 PR이 메인 청크를 키울 때마다 거짓으로 빨개지므로 코드에 못 박지 않는다(PR 본문에 두 `npm run build`
//      원문과 이 게이트의 BASE_DIST 실행을 적는다).
//
// 사용(빌드 뒤):
//   npm run gate:theme-bundle                                  구조 + 크기
//   BASE_DIST=/path/to/base/clients/web/dist npm run gate:theme-bundle   + 메인 증가
//
// 압축은 Vite가 보고하는 크기와 같은 방식(Node `gzip` 기본)이다.
// =============================================================================

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(process.env.DIST || join(webRoot, "dist"));
const baseDist = process.env.BASE_DIST ? resolve(process.env.BASE_DIST) : null;

const LAZY_BUDGET = 25 * 1024; // 설정 모양 쪽 지연 청크의 gzip 합
const MAIN_BUDGET = 2 * 1024; // 메인 청크 gzip 증가

/**
 * 표식: 각 모듈에만 있는 문자열 리터럴.
 *   DeriveError                       파생 엔진(`derive.ts`)의 오류 이름
 *   Catppuccin Macchiato              카탈로그 씨앗 표의 테마 라벨(`themeCatalog.generated.ts`). 갤러리가 그리는 글자라
 *                                     압축·트리 셰이킹을 지나도 남는다(출처 표기 상수는 쓰이지 않아 셰이킹에 사라진다).
 *   theme-tile-paint                  갤러리 타일의 감싸개 클래스(`ThemeTile.tsx`). 「theme-tile」만으로는 기존 간격 토큰
 *                                     이름 `theme-tile-min`(`cn.ts`)에 걸려 메인에서 거짓 양성이 된다
 *   appearance-accent-unavailable     강조색 칩 묶음(`AccentGroup.tsx`)
 */
const MARKERS = ["DeriveError", "Catppuccin Macchiato", "theme-tile-paint", "appearance-accent-unavailable"];

function fail(message) {
  throw new Error(message);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;
const gz = (text) => gzipSync(Buffer.from(text, "utf8")).length;

function readChunks(dir) {
  const assets = join(dir, "assets");
  if (!existsSync(join(dir, "index.html")) || !existsSync(assets)) {
    fail(`${dir}에 빌드 산출물이 없다. 먼저 npm run build.`);
  }
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="\/assets\/([^"]+\.js)"/);
  if (!entryMatch) fail(`${dir}/index.html에서 진입 청크(<script type="module">)를 찾지 못했다`);
  const chunks = new Map();
  for (const name of readdirSync(assets)) {
    if (name.endsWith(".js")) chunks.set(name, readFileSync(join(assets, name), "utf8"));
  }
  if (!chunks.has(entryMatch[1])) fail(`진입 청크 ${entryMatch[1]}이 assets에 없다`);
  return { entry: entryMatch[1], chunks };
}

/** 정적 가져오기만 따라가 부트 때 실리는 청크 전부를 모은다(동적 `import()`와 preload 목록은 따라가지 않는다). */
function bootGraph({ entry, chunks }) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name) || !chunks.has(name)) continue;
    seen.add(name);
    const code = chunks.get(name);
    // `import{a}from"./x.js"` · `import"./x.js"` · `export*from"./x.js"`. 동적은 `import("./x.js")`라 걸리지 않는다.
    for (const dep of staticImports(code)) stack.push(dep);
  }
  return seen;
}

/** 한 청크가 정적으로 가져오는 청크 이름들(`import{a}from"./x.js"` · `import"./x.js"`). 동적 `import()`는 걸리지 않는다. */
function staticImports(code) {
  return [...code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)].map((m) => m[1]);
}

/**
 * 테마 지연 청크: 부트 밖 청크 가운데 표식이 든 것과, 그런 청크를 **정적으로 가져오는** 지연 청크(적용기는 엔진 청크를
 * 가져올 뿐 표식이 없다). 고정점까지 넓힌다.
 */
function themeLazyChunks({ chunks }, boot) {
  const theme = new Set(
    [...chunks.keys()].filter((name) => !boot.has(name) && MARKERS.some((marker) => chunks.get(name).includes(marker)))
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, code] of chunks) {
      if (boot.has(name) || theme.has(name)) continue;
      if (staticImports(code).some((dep) => theme.has(dep))) {
        theme.add(name);
        grew = true;
      }
    }
  }
  return [...theme].sort();
}

function main() {
  const built = readChunks(dist);
  const boot = bootGraph(built);
  const entryGz = gz(built.chunks.get(built.entry));
  const lines = [`dist: ${dist}`, `진입(메인) 청크: ${built.entry}  gzip ${entryGz} B (${kb(entryGz)})`, `부트 때 실리는 청크 ${boot.size}개: ${[...boot].join(", ")}`];

  // ---- 1. 구조 ---------------------------------------------------------------------------------
  for (const marker of MARKERS) {
    const leaked = [...boot].filter((name) => built.chunks.get(name).includes(marker));
    if (leaked.length > 0) {
      fail(
        `표식 "${marker}"이 부트 그래프(${leaked.join(", ")})에 있다. 카탈로그·파생 엔진·갤러리는 지연 청크여야 한다: ` +
          `누군가 메인에서 정적으로 가져왔다(applyDerived.ts의 동적 import()·ThemeStyleRow의 React.lazy를 확인한다).`
      );
    }
    const lazyHolders = [...built.chunks.keys()].filter((name) => !boot.has(name) && built.chunks.get(name).includes(marker));
    if (lazyHolders.length === 0) {
      fail(
        `표식 "${marker}"이 어느 지연 청크에도 없다. 코드가 바뀌어 표식이 사라졌다면 이 게이트의 MARKERS를 고친다: ` +
          `표식을 못 찾는 게이트는 아무것도 지키지 못한다.`
      );
    }
    lines.push(`표식 "${marker}": 부트 그래프에 없음, 지연 청크 ${lazyHolders.join(", ")}`);
  }

  // ---- 2. 크기: 테마 지연 청크 ---------------------------------------------------------------------
  const themeChunks = themeLazyChunks(built, boot);
  const lazyGz = themeChunks.map((name) => [name, gz(built.chunks.get(name))]);
  const lazyTotal = lazyGz.reduce((sum, [, size]) => sum + size, 0);
  for (const [name, size] of lazyGz) lines.push(`  지연 ${name}  gzip ${size} B`);
  lines.push(`테마 지연 청크 gzip 합: ${lazyTotal} B (${kb(lazyTotal)}), 예산 ${LAZY_BUDGET} B (${kb(LAZY_BUDGET)})`);
  if (lazyTotal > LAZY_BUDGET) {
    fail(`테마 지연 청크 gzip 합 ${lazyTotal} B가 예산 ${LAZY_BUDGET} B를 넘는다(${themeChunks.map(basename).join(", ")})`);
  }

  // ---- 3. 메인 증가(기준 번들이 있을 때) ------------------------------------------------------------
  if (baseDist) {
    const base = readChunks(baseDist);
    const baseBoot = bootGraph(base);
    const baseGz = gz(base.chunks.get(base.entry));
    const baseThemeLazy = themeLazyChunks(base, baseBoot);
    if (baseThemeLazy.length > 0) {
      fail(`기준 번들(${baseDist})에 이미 테마 지연 청크(${baseThemeLazy.join(", ")})가 있다. AP-1b 전의 번들이어야 한다.`);
    }
    const delta = entryGz - baseGz;
    lines.push(`기준 메인 청크 ${base.entry}  gzip ${baseGz} B`, `메인 청크 gzip 증가: ${delta} B (${kb(delta)}), 예산 ${MAIN_BUDGET} B (${kb(MAIN_BUDGET)})`);
    if (delta > MAIN_BUDGET) {
      fail(`메인 청크 gzip 증가 ${delta} B가 예산 ${MAIN_BUDGET} B를 넘는다. 메인에 들어온 테마 코드를 지연 청크로 옮긴다.`);
    }
  } else {
    lines.push("메인 증가: BASE_DIST가 없어 단정하지 않았다(절대 크기만 적었다).");
  }

  console.log(["GATE PASS: 테마 번들 예산", ...lines.map((line) => `  ${line}`)].join("\n"));
}

try {
  main();
} catch (error) {
  const message = String(error.message ?? error);
  console.error(message.startsWith("GATE FAIL:") ? message : `GATE FAIL: ${message}`);
  process.exit(1);
}
