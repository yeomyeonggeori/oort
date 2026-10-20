#!/usr/bin/env node
// 작업 공간 하네스 「세션」 칸 캡처 (#4128). 네이티브 select(전) 대 앱이 그린 listbox(후).
//   npm run build:design && node scripts/capture-4128.mjs                   # 후
//   BEFORE=1 OUT_DIR=captures/4128/before node scripts/capture-4128.mjs     # 전(닫힌 모양만)
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/4128");
const PORT = Number(process.env.CAPTURE_PORT || 5198);
const BEFORE = process.env.BEFORE === "1";
const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures.push(name);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(`${preview.origin}/#/design/workbench?preset=two`);
      await page.getByTestId("workbench-grid").waitFor();
      await page.waitForTimeout(300);
      const header = page.getByTestId("workbench-harness").locator("header").first();
      await page.screenshot({ path: resolve(OUT_DIR, `session-closed-1440-${scheme}.png`) });
      await header.screenshot({ path: resolve(OUT_DIR, `session-crop-1440-${scheme}.png`) });
      if (!BEFORE) {
        const box = page.getByRole("combobox", { name: "세션" });
        check(`${scheme} 세션 칸은 combobox 이고 네이티브 select 가 없다`, (await box.count()) === 1 && (await page.locator("select").count()) === 0);
        await box.click();
        await page.getByRole("listbox", { name: "세션" }).waitFor({ timeout: 5000 });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        await page.screenshot({ path: resolve(OUT_DIR, `session-open-1440-${scheme}.png`) });
        const before = await box.getAttribute("data-value");
        await page.getByRole("option").nth(1).click();
        await page.getByRole("listbox").waitFor({ state: "detached", timeout: 3000 });
        check(`${scheme} 고르면 값이 바뀌고 목록이 닫힌다`, (await box.getAttribute("data-value")) !== before && (await page.getByRole("listbox").count()) === 0);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(`${scheme} 가로 넘침 없음`, overflow <= 0, String(overflow));
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  if (failures.length > 0) { console.error(`${failures.length}개 실패`); process.exit(1); }
  console.log("모든 단언 통과");
}
main().catch((e) => { console.error(e); process.exit(1); });
