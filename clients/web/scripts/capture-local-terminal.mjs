#!/usr/bin/env node
// =============================================================================
// 로컬 터미널 도크 캡처와 실브라우저 확인 (#2774).
//
//   npm run capture:local-terminal   build:design 뒤 → artifacts/local-terminal/*.png + report.json
//
// `#/design/local-terminal` 하네스를 Chromium으로 연다. PTY는 흉내다(하네스 머리말).
// 실제 PTY·한글 입력·재시작 복원은 데스크탑 debug 앱에서 잰다(PR 본문).
//
// 장면(라이트·다크, 1280×800): one(칸 하나) · four(4분할) · full(⌃⇧` 전체 화면) ·
// confirm(⌘W 닫기 확인) · exited · failed · settings-desktop · settings-web
//
// 재는 것:
//   - 도크·칸 수, 가로 넘침 0, 흉내 셸 출력이 xterm에 그려졌는지(한글 포함)
//   - ⌃`(code Backquote, key ₩)로 닫고 다시 연다
//   - 터미널 안 입력이 PTY로 가서 되울린다
// =============================================================================

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/local-terminal");
const PORT = Number(process.env.CAPTURE_PORT || 5194);
const VIEWPORT = { width: 1280, height: 800 };

const failures = [];
const report = { scenes: [], checks: [] };

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, scene) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${origin}/#/design/local-terminal?scene=${scene}`);
  return { context, page };
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function shot(page, name) {
  const file = resolve(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  report.scenes.push(name);
}

async function waitOutput(page) {
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll(".xterm-rows")).some((el) => el.textContent?.includes("한글 입력 확인")),
    null,
    { timeout: 10_000 }
  );
}

async function scenes(browser, origin) {
  for (const scheme of ["light", "dark"]) {
    for (const scene of ["one", "four", "full"]) {
      const { context, page } = await open(browser, origin, scheme, scene);
      await page.getByTestId("local-terminal-dock").waitFor();
      await waitOutput(page);
      const panes = await page.getByTestId("workbench-pane").count();
      check(`${scheme}/${scene}: 칸 수`, panes === (scene === "one" ? 1 : 4), { panes });
      check(`${scheme}/${scene}: 가로 넘침 0`, (await overflowX(page)) <= 0);
      if (scene === "four") {
        // H3: 포커스 없는 칸은 커서를 그리지 않는다(신호색은 한 곳). xterm은 한 번도
        // 포커스를 받지 않은 칸의 커서를 그리지 않으므로, 네 칸을 한 번씩 눌러 둔다.
        const terms = page.getByTestId("local-terminal");
        for (let i = 0; i < 4; i++) await terms.nth(i).click();
        await page.waitForTimeout(200);
        const outlines = await page.locator(".xterm-cursor-outline").count();
        check(`${scheme}/four: 포커스 없는 칸의 윤곽 커서 0`, outlines === 0, { outlines });
        // H2: 도크 머리 → Tab이 칸 머리 단추에 머문다(셸로 끌려가지 않는다).
        await page.getByTestId("local-terminal-dock-close").focus();
        await page.keyboard.press("Tab");
        const where = await page.evaluate(() => {
          const a = document.activeElement;
          return { tag: a?.tagName, label: a?.getAttribute("aria-label"), xterm: a?.classList.contains("xterm-helper-textarea") };
        });
        check(`${scheme}/four: Tab이 칸 머리 단추에 머문다`, where.tag === "BUTTON" && !where.xterm, where);
        await page.keyboard.press("Tab");
        const next = await page.evaluate(() => document.activeElement?.tagName);
        check(`${scheme}/four: 다음 Tab도 단추다`, next === "BUTTON", { next });
      }
      if (scene === "full") {
        const hidden = await page.evaluate(
          () => document.querySelector('[data-testid="local-terminal-dock"]')?.getBoundingClientRect().top ?? -1
        );
        check(`${scheme}/full: 도크가 판 위까지 찬다`, hidden >= 0 && hidden < 40, { top: hidden });
      }
      await shot(page, `${scheme}-${scene}`);
      if (scene === "one") {
        // ⌘W → 실행 중 칸 닫기 확인
        await page.locator(".xterm-helper-textarea").first().focus();
        await page.keyboard.press("Meta+KeyW");
        await page.getByTestId("local-terminal-close-confirm").waitFor();
        const focusedDestroy = await page.evaluate(
          () => document.activeElement?.getAttribute("data-testid") === "local-terminal-close-confirm-ok"
        );
        check(`${scheme}/confirm: 파괴 단추가 기본 포커스가 아니다`, !focusedDestroy);
        await shot(page, `${scheme}-confirm`);
      }
      await context.close();
    }
    for (const scene of ["exited", "failed"]) {
      const { context, page } = await open(browser, origin, scheme, scene);
      await page.getByTestId("local-terminal-restart").waitFor();
      const status = await page.getByTestId("local-terminal-status").textContent();
      check(`${scheme}/${scene}: 칸 상태 줄이 무슨 일과 다음 행동을 말한다`, /끝났습니다|열지 못했습니다/.test(status ?? ""), { status });
      await shot(page, `${scheme}-${scene}`);
      await context.close();
    }
    for (const scene of ["settings-desktop", "settings-web"]) {
      const { context, page } = await open(browser, origin, scheme, scene);
      await page.getByTestId("terminal-shortcut-table").waitFor();
      check(`${scheme}/${scene}: 가로 넘침 0`, (await overflowX(page)) <= 0);
      await shot(page, `${scheme}-${scene}`);
      await context.close();
    }
  }
}

async function interactions(browser, origin) {
  const { context, page } = await open(browser, origin, "light", "one");
  await page.getByTestId("local-terminal-dock").waitFor();
  await waitOutput(page);
  const input = page.locator(".xterm-helper-textarea").first();
  await input.focus();
  await page.keyboard.type("ls -la");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    // xterm은 빈칸을 NBSP로 그린다.
    () => document.querySelector(".xterm-rows")?.textContent?.replace(/\u00a0/g, " ").includes("ls -la"),
    null,
    { timeout: 5_000 }
  );
  check("입력이 PTY로 가서 되울린다", true);

  // ⌃`: 물리 키. 한글 2벌식이면 key가 ₩다. 합성 사건으로 key를 ₩로 준다.
  const press = (key) =>
    page.evaluate((k) => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Backquote", key: k, ctrlKey: true }));
    }, key);
  await press("₩");
  await page.getByTestId("local-terminal-dock").waitFor({ state: "detached" });
  check("⌃`(key ₩)로 도크를 닫는다", true);
  await press("₩");
  await page.getByTestId("local-terminal-dock").waitFor();
  await waitOutput(page);
  const kept = await page.evaluate(() =>
    document.querySelector(".xterm-rows")?.textContent?.replace(/\u00a0/g, " ").includes("ls -la")
  );
  check("다시 열면 전의 화면이 그대로다(미러에서 다시 그림)", kept === true);
  await context.close();
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ 가 없다. npm run capture:local-terminal 로 build:design 부터 돌린다.");
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

await main();
