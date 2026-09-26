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

  // R2 H1: 메뉴에서 새 세션을 고른 뒤 바로 친 키가 새 칸의 터미널에 들어간다.
  {
    const { context: c2, page: p2 } = await open(browser, origin, "light", "one");
    await p2.getByTestId("local-terminal-dock").waitFor();
    await waitOutput(p2);
    await p2.getByTestId("local-terminal-new").click();
    await p2.getByTestId("local-terminal-new-shell").click();
    await p2.waitForFunction(() => document.querySelectorAll('[data-testid="workbench-pane"]').length === 2);
    await p2.waitForTimeout(300);
    await p2.keyboard.type("whoami-after-menu");
    await p2.waitForTimeout(300);
    const landed = await p2.evaluate(() => {
      const pane = document.querySelector('[data-testid="workbench-pane"][data-focused]');
      return pane?.querySelector(".xterm-rows")?.textContent?.includes("whoami-after-menu") ?? false;
    });
    check("메뉴로 연 새 칸에 바로 입력된다", landed);
    // 칸 목록(⌘J)으로 1번 칸을 고르고 친다.
    await p2.getByTestId("local-terminal-jump").click();
    await p2.getByTestId("local-terminal-jump-list").getByRole("menuitem").first().click();
    await p2.waitForTimeout(300);
    await p2.keyboard.type("picked-from-list");
    await p2.waitForTimeout(300);
    const landed2 = await p2.evaluate(() => {
      const pane = document.querySelector('[data-testid="workbench-pane"][data-pane-id="p1"]');
      return pane?.querySelector(".xterm-rows")?.textContent?.includes("picked-from-list") ?? false;
    });
    check("칸 목록에서 고른 칸에 바로 입력된다", landed2);
    await c2.close();
  }

  // R2 B1 / R3 B1: 좁은 칸(최소 240px 근처)에서도 상태 줄이 칸 안에 있고, 단추가
  // 보이며, 문장이 잘리지 않는다. 가장 긴 단추 문구(하네스)로 잰다.
  // R4 B1: 데스크탑 최소 창(720×480)과 낮은 창에서도 칸이 최소 높이를 지켜 상태
  // 줄이 칸 안에 든다(도크 최소 높이 = 배치의 칸 줄 수 × 칸 최소 높이).
  for (const [scene, width, height] of [
    ["failed-four", 900, 800],
    ["exited-four", 640, 800],
    ["failed-four", 520, 800],
    ["exited-harness-four", 520, 800],
    ["failed-four", 720, 480],
    ["exited-harness-four", 720, 480],
    ["exited-harness-four", 520, 700],
  ]) {
    const context3 = await browser.newContext({ viewport: { width, height }, colorScheme: "light", reducedMotion: "reduce" });
    const p3 = await context3.newPage();
    await p3.goto(`${origin}/#/design/local-terminal?scene=${scene}`);
    await p3.locator('[data-testid="local-terminal-restart"]:visible').first().waitFor();
    const r = await p3.evaluate(() => {
      const out = [];
      for (const pane of document.querySelectorAll('[data-testid="workbench-pane"]')) {
        if (getComputedStyle(pane).visibility === "hidden") continue; // 좁을 때 가려진 칸
        const pr = pane.getBoundingClientRect();
        const status = pane.querySelector('[data-testid="local-terminal-status"]');
        const p = status?.querySelector('[role="status"]');
        const btn = status?.querySelector('[data-testid="local-terminal-restart"]');
        if (!status || !p) continue;
        const sr = status.getBoundingClientRect();
        const br = btn?.getBoundingClientRect();
        out.push({
          paneW: Math.round(pr.width),
          inside: sr.bottom <= pr.bottom + 0.5 && sr.left >= pr.left - 0.5 && sr.right <= pr.right + 0.5,
          buttonInside: !br || (br.right <= pr.right + 0.5 && br.bottom <= pr.bottom + 0.5 && br.width > 0),
          overflowPx: Math.max(0, Math.round((br?.bottom ?? sr.bottom) - pr.bottom)),
          textClipped: p.scrollWidth > p.clientWidth + 1,
          textLines: Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)),
          terminalH: Math.round(pane.querySelector('[data-testid="local-terminal"]')?.getBoundingClientRect().height ?? 0),
        });
      }
      return out;
    });
    const ok = r.length > 0 && r.every((x) => x.inside && x.buttonInside && !x.textClipped && x.textLines <= 2);
    const panesOk = await p3.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="workbench-pane"]'))
        .filter((e) => getComputedStyle(e).visibility !== "hidden")
        .every((e) => e.getBoundingClientRect().height >= 119.5)
    );
    check(`${scene}@${width}x${height}: 상태 줄이 칸 안, 단추 보임, 문장 두 줄 이하`, ok, r[0]);
    check(`${scene}@${width}x${height}: 칸이 최소 높이 120을 지킨다`, panesOk);
    await p3.screenshot({ path: resolve(OUT_DIR, `light-${scene}-${width}x${height}.png`) });
    report.scenes.push(`light-${scene}-${width}x${height}`);
    await context3.close();
  }
  // R4 M2 / R5 B-1: 도는 칸의 알림(저장 실패)은 칸 안에 뜨지 않는다(캐럿 줄을
  // 가리지 않는다). 격자 상태 줄에 칸 번호와 함께 뜨고, 터미널 높이는 그대로다.
  {
    const c6 = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", reducedMotion: "reduce" });
    const p6 = await c6.newPage();
    await p6.goto(`${origin}/#/design/local-terminal?scene=storage-fail`);
    await p6.getByTestId("local-terminal-dock").waitFor();
    const h0 = await p6.evaluate(() => Math.round(document.querySelector('[data-testid="local-terminal"]').getBoundingClientRect().height));
    await p6.getByTestId("workbench-notice").filter({ hasText: "저장하지 못했습니다" }).waitFor();
    const r6 = await p6.evaluate(() => ({
      h1: Math.round(document.querySelector('[data-testid="local-terminal"]').getBoundingClientRect().height),
      inPane: Array.from(document.querySelectorAll('[data-testid="local-terminal-status"]')).filter((e) => e.getBoundingClientRect().height > 0).length,
      text: document.querySelector('[data-testid="workbench-notice"]')?.textContent,
    }));
    check("도는 칸의 저장 실패는 칸 밖(격자 상태 줄)에 뜨고 터미널 높이가 그대로다", r6.inPane === 0 && r6.h1 === h0 && /^1번 칸/.test(r6.text ?? ""), { h0, ...r6 });
    await p6.screenshot({ path: resolve(OUT_DIR, "light-storage-fail.png") });
    report.scenes.push("light-storage-fail");
    await c6.close();
  }
  // R5 B-2 / H-1: 중첩 분할(½·¼·¼)도 칸이 최소 높이를 지키고, 도크가 창을 넘지
  // 않는다. 자리가 모자라면 포커스 칸 하나만 온전히 보인다.
  for (const [scene, width, height] of [
    ["stack3", 1280, 800],
    ["stack3-exited", 520, 800],
    ["stack3", 720, 480],
    ["stack3-exited", 720, 480],
  ]) {
    const c7 = await browser.newContext({ viewport: { width, height }, colorScheme: "light", reducedMotion: "reduce" });
    const p7 = await c7.newPage();
    await p7.goto(`${origin}/#/design/local-terminal?scene=${scene}`);
    await p7.getByTestId("local-terminal-dock").waitFor();
    await p7.waitForTimeout(400);
    const r7 = await p7.evaluate(() => {
      const dock = document.querySelector('[data-testid="local-terminal-dock"]').getBoundingClientRect();
      const visible = Array.from(document.querySelectorAll('[data-testid="workbench-pane"]')).filter(
        (e) => getComputedStyle(e).visibility !== "hidden"
      );
      const heights = visible.map((e) => Math.round(e.getBoundingClientRect().height));
      const statusOk = visible.every((pane) => {
        const st = pane.querySelector('[data-testid="local-terminal-status"]');
        if (!st || st.getBoundingClientRect().height === 0) return true;
        return st.getBoundingClientRect().bottom <= pane.getBoundingClientRect().bottom + 0.5;
      });
      const cramped = document.querySelector('[data-testid="workbench-area"]')?.hasAttribute("data-cramped");
      const channel = document.querySelector("h1")?.getBoundingClientRect();
      return {
        dockBottom: Math.round(dock.bottom),
        vh: window.innerHeight,
        heights,
        statusOk,
        cramped,
        channelVisibleTop: channel ? Math.round(dock.top - channel.top) : null,
      };
    });
    const ok = r7.dockBottom <= r7.vh && r7.heights.every((h) => h >= 119.5) && r7.statusOk;
    check(`${scene}@${width}x${height}: 칸 ≥120, 도크가 창 안, 상태 줄이 칸 안`, ok, r7);
    await p7.screenshot({ path: resolve(OUT_DIR, `light-${scene}-${width}x${height}.png`) });
    report.scenes.push(`light-${scene}-${width}x${height}`);
    await c7.close();
  }
  // R3 H: 터미널에서 ⌘J로 연 칸 목록을 Esc로 닫으면 캐럿이 터미널로 돌아간다.
  {
    const { context: c5, page: p5 } = await open(browser, origin, "light", "four");
    await p5.getByTestId("local-terminal-dock").waitFor();
    await waitOutput(p5);
    await p5.getByTestId("local-terminal").nth(2).click();
    await p5.keyboard.press("Meta+KeyJ");
    await p5.getByTestId("local-terminal-jump-list").waitFor();
    await p5.keyboard.press("Escape");
    await p5.waitForTimeout(300);
    const where = await p5.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false);
    check("⌘J → Esc 뒤 캐럿이 터미널에 있다", where);
    // R3 M: ⌃⇧J 알림이 떠도 칸 높이(= PTY 크기)가 바뀌지 않는다.
    const before = await p5.evaluate(() => Array.from(document.querySelectorAll('[data-testid="local-terminal"]')).map((e) => Math.round(e.getBoundingClientRect().height)));
    await p5.keyboard.press("Control+Shift+KeyJ");
    await p5.getByTestId("workbench-notice").filter({ hasText: "기다리는" }).waitFor();
    const after = await p5.evaluate(() => Array.from(document.querySelectorAll('[data-testid="local-terminal"]')).map((e) => Math.round(e.getBoundingClientRect().height)));
    check("⌃⇧J 알림이 칸 높이를 바꾸지 않는다", JSON.stringify(before) === JSON.stringify(after), { before, after });
    await c5.close();
  }
  {
    const context4 = await browser.newContext({ viewport: { width: 420, height: 700 }, colorScheme: "light", reducedMotion: "reduce" });
    const p4 = await context4.newPage();
    await p4.goto(`${origin}/#/design/local-terminal?scene=four`);
    await p4.getByTestId("local-terminal-dock").waitFor();
    await p4.keyboard.press("Control+Shift+KeyN");
    await p4.getByTestId("workbench-notice").filter({ hasText: "칸이 좁아" }).waitFor();
    const n = await p4.evaluate(() => {
      const el = document.querySelector('[data-testid="workbench-notice"]');
      return { clipped: el.scrollWidth > el.clientWidth + 1, text: el.textContent };
    });
    check("420 폭: 도크 알림이 다음 행동까지 보인다", !n.clipped && n.text.includes("키우세요"), n);
    await p4.screenshot({ path: resolve(OUT_DIR, "light-notice-420.png") });
    report.scenes.push("light-notice-420");
    await context4.close();
  }
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
