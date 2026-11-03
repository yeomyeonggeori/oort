#!/usr/bin/env node
// =============================================================================
// CAPTURE (#5101 M1): 첫 화면(D0)의 언어 칩이 다음 장(D1)과 같은 자리에 서는가.
//
//   후: npm run build && node scripts/capture-5101.mjs
//   전·사보타주: DIST_DIR=<고치기 전 번들> node scripts/capture-5101.mjs     # 종료 코드 1이어야 한다
//
// 머리 줄은 `1fr auto 1fr` 세 칸인데 D0에는 진행 점이 없다. 칩의 칸이 정해져 있지 않으면 자식이 둘뿐인 줄에서
// 칩이 가운데 칸으로 들어가 D1에서 오른쪽 끝으로 옮겨 간다. jsdom은 격자를 배치하지 않으므로(시험으로는 이
// 자리를 못 잰다) **렌더된 상자**를 번들 Chromium(헤드리스)으로 잰다. 서버는 없다: `/v1/**` 는 404이고 D0·D1은
// 서버 없이 선다. 사진은 찍지 않는다(화면 캡처는 검증 줄 몫). 단언이 하나라도 실패하면 종료 코드 1이다.
//
// 재는 것 (1440·390 x 밝음·어두움):
//   1 전제     D0 머리 줄에는 진행 점이 없고 D1에는 있다(점이 없는 줄에서 재는 시험이다)
//   2 자리     D0 칩의 오른쪽 끝 = 머리 줄 안쪽 오른쪽 끝(여백 안). 가운데 칸에 들어가지 않는다
//   3 같은 자리 D0 칩과 D1 칩의 오른쪽 끝·폭이 같다
//   4 D1 가운데 D1의 진행 점은 머리 줄 안쪽 가운데에 선다(칸을 고정해도 점이 밀리지 않는다)
//   5 신호등 인셋 Tauri 창은 드래그 표지로 왼쪽을 80 비운다(`data-tauri-drag-region`). 표지만 달아 흉내 낸
//             줄에서도 D0 칩의 오른쪽 끝이 그대로다(데스크탑 창 자체는 runtime-unverified)
// =============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = process.env.DIST_DIR ? resolve(process.env.DIST_DIR) : resolve(WEB_ROOT, "dist");
const PORT = Number(process.env.CAPTURE_PORT || 5101);
// 반올림 오차만 받는다: 칸이 다르면 차이는 수십~수백 px다.
const TOLERANCE_PX = 1;

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const SCHEMES = ["light", "dark"];

const failures = [];
function check(where, name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${where} ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(`${where} ${name}: ${detail ?? ""}`);
}

/** 머리 줄·칩·점의 렌더된 상자. 값은 CSS px다. */
function readHeader(page) {
  return page.evaluate(() => {
    const header = document.querySelector('[data-testid="onboarding-step-chrome"]');
    const chip = document.querySelector('[data-testid="language-chip"]');
    const dots = document.querySelector('[data-testid="onboarding-dots"]');
    if (!header || !chip) return null;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    };
    const css = getComputedStyle(header);
    return {
      header: box(header),
      chip: box(chip),
      dots: dots ? box(dots) : null,
      padLeft: parseFloat(css.paddingLeft),
      padRight: parseFloat(css.paddingRight),
      // 눈에 보이는 자식만이 아니라 줄의 직접 자식 전부다.
      children: header.children.length,
    };
  });
}

const fmt = (n) => n.toFixed(1);

async function measure(browser, origin, scheme, viewport) {
  const where = `${viewport.name} ${scheme}`;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    // 줄임 모션 컨텍스트는 다음 장의 마스크 드러내기를 건너뛴다(advanceOnboarding.mjs 머리말).
    reducedMotion: "reduce",
    locale: "ko-KR",
  });
  try {
    const page = await context.newPage();
    await context.route("**/v1/**", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "" })
    );
    await page.goto(origin);
    await page.getByTestId("onboarding-welcome").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("language-chip").waitFor({ state: "visible", timeout: 20_000 });
    const d0 = await readHeader(page);
    if (!d0) {
      check(where, "D0 머리 줄·칩을 읽었다", false, "onboarding-step-chrome 또는 language-chip 이 없다");
      return;
    }

    // 5: 신호등 인셋을 흉내 낸 줄에서 D0 칩이 어디에 서는가(표지만 달고, 읽은 뒤 되돌린다).
    await page.evaluate(() =>
      document
        .querySelector('[data-testid="onboarding-step-chrome"]')
        ?.setAttribute("data-tauri-drag-region", "")
    );
    const d0Inset = await readHeader(page);
    await page.evaluate(() =>
      document
        .querySelector('[data-testid="onboarding-step-chrome"]')
        ?.removeAttribute("data-tauri-drag-region")
    );

    await advanceToAccount(page);
    await page.getByTestId("onboarding-dots").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("language-chip").waitFor({ state: "visible", timeout: 20_000 });
    const d1 = await readHeader(page);
    if (!d1 || !d1.dots) {
      check(where, "D1 머리 줄·칩·점을 읽었다", false, JSON.stringify(d1));
      return;
    }

    check(where, "1 전제: D0 머리 줄에 진행 점이 없다", d0.dots === null, `자식 ${d0.children}`);
    check(where, "1 전제: D1 머리 줄에 진행 점이 있다", d1.dots !== null, `자식 ${d1.children}`);

    const innerRight = (h) => h.header.right - h.padRight;
    const d0Gap = innerRight(d0) - d0.chip.right;
    check(
      where,
      "2 자리: D0 칩이 머리 줄 안쪽 오른쪽 끝에 선다",
      Math.abs(d0Gap) <= TOLERANCE_PX,
      `칩 오른쪽 ${fmt(d0.chip.right)}, 안쪽 오른쪽 끝 ${fmt(innerRight(d0))}, 틈 ${fmt(d0Gap)}px (뷰포트 가운데 ${fmt(viewport.width / 2)}, 칩 가운데 ${fmt(d0.chip.left + d0.chip.width / 2)})`
    );

    check(
      where,
      "3 같은 자리: D0와 D1의 칩 오른쪽 끝",
      Math.abs(d0.chip.right - d1.chip.right) <= TOLERANCE_PX,
      `D0 ${fmt(d0.chip.right)} · D1 ${fmt(d1.chip.right)}`
    );
    check(
      where,
      "3 같은 자리: D0와 D1의 칩 폭",
      Math.abs(d0.chip.width - d1.chip.width) <= TOLERANCE_PX,
      `D0 ${fmt(d0.chip.width)} · D1 ${fmt(d1.chip.width)}`
    );

    const innerCenter = (h) => (h.header.left + h.padLeft + innerRight(h)) / 2;
    const dotsCenter = d1.dots.left + d1.dots.width / 2;
    check(
      where,
      "4 D1 가운데: 진행 점이 머리 줄 안쪽 가운데에 선다",
      Math.abs(dotsCenter - innerCenter(d1)) <= TOLERANCE_PX,
      `점 가운데 ${fmt(dotsCenter)} · 줄 안쪽 가운데 ${fmt(innerCenter(d1))}`
    );

    check(
      where,
      "5 신호등 인셋: 왼쪽을 비워도 D0 칩의 오른쪽 끝이 그대로다",
      d0Inset !== null && d0Inset.padLeft > d0.padLeft && Math.abs(d0Inset.chip.right - d0.chip.right) <= TOLERANCE_PX,
      d0Inset
        ? `왼쪽 여백 ${fmt(d0.padLeft)} → ${fmt(d0Inset.padLeft)}, 칩 오른쪽 ${fmt(d0.chip.right)} → ${fmt(d0Inset.chip.right)}`
        : "읽지 못했다"
    );
  } finally {
    await context.close();
  }
}

if (!existsSync(resolve(DIST_DIR, "index.html"))) {
  throw new Error(`${DIST_DIR}/index.html is missing. Build first (npm run build).`);
}
const preview = await startGuardedPreview({
  webRoot: WEB_ROOT,
  port: PORT,
  portEnvVar: "CAPTURE_PORT",
  extraArgs: ["--outDir", DIST_DIR],
});
const browser = await chromium.launch();
try {
  console.log(`번들: ${DIST_DIR}`);
  for (const viewport of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      await measure(browser, preview.origin, scheme, viewport);
    }
  }
} finally {
  await browser.close();
  await preview.stop();
}
if (failures.length > 0) {
  console.error(`\n${failures.length}건 실패`);
  process.exit(1);
}
console.log("\n모두 통과");
