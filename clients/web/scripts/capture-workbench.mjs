#!/usr/bin/env node
// =============================================================================
// 작업 공간 격자 캡처와 실브라우저 확인 (#2773).
//
//   npm run capture:workbench     build:design 뒤 → artifacts/workbench/*.png + report.json
//
// `#/design/workbench` 하네스를 Chromium으로 연다. 세션도 백엔드도 없다.
//
// 장면(라이트·다크 각각, 1280×800):
//   two   2분할(오른쪽으로 나눔)
//   four  4분할(두 열을 각각 아래로)
//   max   4분할에서 3번 칸 최대화(다른 칸은 DOM에 남음)
//   narrow 900×800에서 4분할, 칸 하나를 더 나누려다 거부된 문구
//
// 재는 것(실브라우저, jsdom이 못 보는 것):
//   - 칸 수, 최대화 칸이 격자 전체를 덮는지(상자 비교), 가려진 칸이 DOM에 남는지
//   - 가로 넘침 0
//   - ⌘D(물리 키 KeyD)로 실제 분할, 경계를 마우스로 끌어 비율이 바뀌는지
//   - 프리셋 없이 연 하네스에서 나눈 배치가 새로고침 뒤에도 남는지(이 기기 저장)
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/workbench");
const PORT = Number(process.env.CAPTURE_PORT || 5193);
const VIEWPORT = { width: 1280, height: 800 };

const failures = [];
const report = { scenes: [], checks: [] };

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, query, viewport = VIEWPORT) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${origin}/#/design/workbench${query}`);
  await page.getByTestId("workbench-grid").waitFor();
  return { context, page };
}

async function measure(page) {
  return page.evaluate(() => {
    const area = document.querySelector('[data-testid="workbench-area"]').getBoundingClientRect();
    const panes = Array.from(document.querySelectorAll('[data-testid="workbench-pane"]')).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute("data-pane-id"),
        maximized: el.hasAttribute("data-maximized"),
        inert: el.hasAttribute("inert"),
        visible: getComputedStyle(el).visibility === "visible",
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    });
    const overflow = [document.documentElement, ...document.querySelectorAll("*")].some(
      (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible"
    );
    const docOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    return {
      area: { x: area.x, y: area.y, width: area.width, height: area.height },
      panes,
      overflow: overflow || docOverflow,
      status: document.querySelector('[data-testid="workbench-status"]').textContent,
    };
  });
}

async function shoot(page, name) {
  const file = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  report.scenes.push(name);
  return file;
}

async function scenes(browser, origin) {
  for (const scheme of ["light", "dark"]) {
    for (const [preset, count] of [
      ["two", 2],
      ["four", 4],
      ["max", 4],
    ]) {
      const { context, page } = await open(browser, origin, scheme, `?preset=${preset}`);
      const m = await measure(page);
      check(`${scheme}/${preset}: 칸 ${count}개`, m.panes.length === count, { got: m.panes.length });
      check(`${scheme}/${preset}: 가로 넘침 0`, !m.overflow);
      if (preset === "max") {
        const maxed = m.panes.find((p) => p.maximized);
        const covers =
          maxed &&
          Math.abs(maxed.rect.width - m.area.width) < 1 &&
          Math.abs(maxed.rect.height - m.area.height) < 1;
        check(`${scheme}/max: 최대화 칸이 격자를 덮는다`, Boolean(covers), maxed?.rect);
        const others = m.panes.filter((p) => !p.maximized);
        check(
          `${scheme}/max: 다른 칸 3개가 DOM에 남고 inert·보이지 않음`,
          others.length === 3 && others.every((p) => p.inert && !p.visible)
        );
      } else {
        // 칸끼리 겹치지 않고 격자 안에 있다.
        const inside = m.panes.every(
          (p) =>
            p.rect.x >= m.area.x - 0.5 &&
            p.rect.y >= m.area.y - 0.5 &&
            p.rect.x + p.rect.width <= m.area.x + m.area.width + 0.5 &&
            p.rect.y + p.rect.height <= m.area.y + m.area.height + 0.5
        );
        check(`${scheme}/${preset}: 칸이 격자 안에 있다`, inside);
      }
      await shoot(page, `workbench-${preset}-${scheme}`);
      await context.close();
    }

    // 좁은 창: 4분할에서 칸 하나(폭 약 440)를 다시 나누면 두 칸이 240 아래라 거부.
    const { context, page } = await open(browser, origin, scheme, "?preset=four", { width: 900, height: 800 });
    await page.locator('[data-pane-id="p1"]').click({ position: { x: 40, y: 80 } });
    await page.keyboard.press("Meta+KeyD");
    const m = await measure(page);
    check(`${scheme}/narrow: 거부 뒤 칸 4개 그대로`, m.panes.length === 4, { got: m.panes.length });
    check(`${scheme}/narrow: 거부 문구`, m.status.includes("칸이 좁아"), { status: m.status });
    check(`${scheme}/narrow: 가로 넘침 0`, !m.overflow);
    await shoot(page, `workbench-narrow-refused-${scheme}`);
    await context.close();
  }
}

async function interactions(browser, origin) {
  // 링은 격자가 실제 포커스를 가질 때만(design-review H1).
  {
    const { context, page } = await open(browser, origin, "light", "?preset=two");
    const ringOf = () =>
      page.evaluate(() => getComputedStyle(document.querySelector("[data-focused]")).outlineStyle);
    const idle = await ringOf();
    check("로드 직후(포커스가 격자 밖) 활성 칸에 신호색 링 없음", idle === "none", { idle });
    await page.locator('[data-pane-id="p2"]').click({ position: { x: 40, y: 80 } });
    const active = await ringOf();
    check("칸을 누른 뒤(격자에 포커스) 링이 보인다", active === "solid", { active });
    await page.getByLabel("세션 고르기").focus();
    const away = await ringOf();
    check("포커스가 세션 선택으로 가면 링이 사라진다", away === "none", { away });
    await context.close();
  }

  // 프리셋 없음: 진짜 localStorage.
  const { context, page } = await open(browser, origin, "light", "");
  await page.locator('[data-pane-id="p1"]').click({ position: { x: 40, y: 80 } });
  await page.keyboard.press("Meta+KeyD");
  let m = await measure(page);
  check("⌘D(KeyD)로 실제 분할", m.panes.length === 2, { got: m.panes.length });

  const sep = page.getByRole("separator");
  const before = Number(await sep.getAttribute("aria-valuenow"));
  const box = await sep.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = Number(await sep.getAttribute("aria-valuenow"));
  check("경계를 끌면 비율이 줄어든다", after < before, { before, after });

  await sep.dblclick();
  const toggled = Number(await sep.getAttribute("aria-valuenow"));
  check("더블클릭 → 균등(50)", toggled === 50, { toggled });
  await sep.dblclick();
  const back = Number(await sep.getAttribute("aria-valuenow"));
  check("다시 더블클릭 → 끌어 둔 비율", back === after, { back, after });

  await page.reload();
  await page.getByTestId("workbench-grid").waitFor();
  m = await measure(page);
  check("새로고침 뒤에도 배치가 남는다(이 기기 저장)", m.panes.length === 2, { got: m.panes.length });
  const kept = Number(await page.getByRole("separator").getAttribute("aria-valuenow"));
  check("새로고침 뒤 비율도 남는다", kept === after, { kept, after });

  // 다른 세션은 따로.
  await page.getByLabel("세션 고르기").selectOption({ index: 1 });
  m = await measure(page);
  check("다른 세션은 자기 배치(칸 1개)", m.panes.length === 1, { got: m.panes.length });
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ 가 없다. npm run capture:workbench 로 build:design 부터 돌린다.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      await scenes(browser, preview.origin);
      await interactions(browser, preview.origin);
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
  writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    console.error(`\nFAIL ${failures.length}: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nOK ${report.checks.length} checks, ${report.scenes.length} shots → ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
