#!/usr/bin/env node
// #3774 타이포 제안 적용 미리보기. 앱 토큰은 바꾸지 않는다.
//   npm run build:design && node scripts/typography-preview.mjs
// dist의 실제 컴파일된 CSS 위에 docs/design-system/typography-preview/preview.html 목업을 얹고,
// after.css를 얹은 판과 안 얹은 판을 같은 목업으로 찍어 전후 비교 PNG를 만든다.
// 목업은 실제 화면이 아니라 정적 마크업이다(실제 앱 캡처 아님).
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PV = resolve(WEB, "../../docs/design-system/typography-preview");
const OUT = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : PV;
const cssFile = readdirSync(resolve(WEB, "dist/assets")).find((f) => /^index-.*\.css$/.test(f));
if (!cssFile) throw new Error("dist가 없어요. npm run build:design을 먼저 돌려요.");
const base = readFileSync(resolve(WEB, "dist/assets", cssFile), "utf8");
const after = readFileSync(resolve(PV, "after.css"), "utf8");
const tpl = readFileSync(resolve(PV, "preview.html"), "utf8");
const html = (variant) =>
  tpl
    .replace("<!--BASE_CSS-->", () => `<style>${base}</style>`)
    .replace("<!--AFTER_CSS-->", () => (variant === "after" ? `<style>${after}</style>` : ""));
const SCREENS = ["1-timeline", "2-sidebar", "3-inbox", "4-settings", "5-onboarding", "6-phone"];
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const shots = {};
for (const scheme of ["light", "dark"]) {
  for (const variant of ["before", "after"]) {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 }, deviceScaleFactor: 1, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.setContent(html(variant), { waitUntil: "load" });
    for (const s of SCREENS) {
      const buf = await page.locator(`[data-screen="${s}"]`).screenshot();
      shots[`${s}-${variant}-${scheme}`] = buf.toString("base64");
    }
    await ctx.close();
  }
}
const ctx = await browser.newContext({ viewport: { width: 2700, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
for (const scheme of ["light", "dark"]) {
  for (const s of SCREENS) {
    const phone = s === "6-phone";
    const w = phone ? 390 : 1280;
    const fig = (v) =>
      `<figure style="margin:0"><figcaption style="font:600 14px system-ui;padding:6px 0;color:#444">${v === "before" ? "현재 (before)" : "제안 (after)"}</figcaption><img style="display:block;width:${w}px" src="data:image/png;base64,${shots[`${s}-${v}-${scheme}`]}"></figure>`;
    await page.setContent(
      `<body style="margin:0;padding:12px;background:#fff;display:flex;gap:24px;width:max-content">${fig("before")}${fig("after")}</body>`,
    );
    await page.locator("body").screenshot({ path: resolve(OUT, `compare-${s}-${scheme}.png`) });
  }
}
await browser.close();
console.log("done", OUT);
