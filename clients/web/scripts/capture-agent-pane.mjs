#!/usr/bin/env node
// =============================================================================
// A 칸 진행 뷰 캡처와 실브라우저 확인 (#2779).
//
//   npm run capture:agent-pane   build:design 뒤 → artifacts/agent-pane/*.png + report.json
//
// `#/design/local-terminal?scene=agent-*` 하네스를 Chromium으로 연다. 원천은 흉내다
// (`agentPaneFixtures`). 데스크탑 셸(Tauri) 안의 모습은 같은 React 트리이고, 실제
// workd 세션·서버 투영과의 왕복은 runtime-unverified다(PR 본문).
//
// 장면(라이트·다크): 1280×800 「내 작업」(로컬 1 + A 2) · 390×844 A 한 칸 ·
// 1280 소유자 아님 · 1280 결정 경로 없음 · 1280 긴 목록(600) · 1280 원문 펼침·무장.
// MOCKUP=<workspace-tab-mockups.html> 가 있으면 시안 ⑤ 스레드 카드와 나란히 놓는다.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/agent-pane");
const PORT = Number(process.env.CAPTURE_PORT || 5196);
const MOCKUP = process.env.MOCKUP ?? "";
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const failures = [];
const report = { scenes: [], checks: [] };

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}

async function open(browser, origin, scheme, scene, viewport = DESKTOP) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${origin}/#/design/local-terminal?scene=${scene}`);
  await page.getByTestId("my-work-tab").waitFor();
  await page.getByTestId("agent-pane").first().waitFor();
  return { context, page };
}

async function overflowX(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
  report.scenes.push(name);
}

async function scenes(browser, origin) {
  for (const scheme of ["light", "dark"]) {
    {
      const { context, page } = await open(browser, origin, scheme, "agent-tab");
      const lanes = await page.$$eval('[data-testid="workbench-pane-lane"]', (els) => els.map((e) => e.getAttribute("data-lane")));
      check(`${scheme}/tab: 레인 표지(로컬 1, 에이전트 2)`, lanes.filter((l) => l === "agent").length === 2 && lanes.includes("local"), { lanes });
      const labels = await page.$$eval('[data-testid="workbench-pane"]', (els) => els.map((e) => e.getAttribute("aria-label")));
      check(`${scheme}/tab: A 칸 접근 이름에 「에이전트 · oort에 기록」`, labels.some((l) => l?.includes("에이전트 · oort에 기록")), { labels });
      const perm = await page.$$eval('[data-testid="agent-permission"]', (els) => els.length);
      check(`${scheme}/tab: 권한 카드 1(기다림 칸)`, perm === 1, { perm });
      const text = await page.textContent('[data-testid="agent-permission"]');
      check(`${scheme}/tab: 「항상 허용」 없음`, !/항상|Always/.test(text ?? ""), { text });
      check(`${scheme}/tab: 가로 넘침 0`, (await overflowX(page)) <= 0);
      const skipped = await page.textContent('[data-testid="agent-pane-skipped"]');
      check(`${scheme}/tab: 모르는 종류 한 줄 폴백`, skipped?.includes("1개") ?? false, { skipped });
      const waiting = await page.$$eval('[data-testid="workbench-pane"][data-waiting]', (els) => els.length);
      check(`${scheme}/tab: 기다림 칸 테두리·바닥 띠`, waiting === 1, { waiting });
      await shot(page, `agent-tab-1280-${scheme}`);

      // 원문 펼치기 + 허락 무장(두 번째 누름 전).
      await page.locator('[data-pane-id="p3"] [data-testid="agent-tool-card"] button').nth(2).click();
      await page.getByTestId("agent-tool-raw").waitFor();
      await page.getByTestId("agent-permission-allow").click();
      await page.getByTestId("agent-permission-confirm").waitFor();
      await shot(page, `agent-tab-1280-${scheme}-armed-raw`);
      await context.close();
    }
    {
      const { context, page } = await open(browser, origin, scheme, "agent-one", PHONE);
      check(`${scheme}/390: 가로 넘침 0`, (await overflowX(page)) <= 0);
      const buttons = await page.$$eval('[data-testid="agent-permission"] button', (els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { w: r.width, right: r.right };
        })
      );
      check(`${scheme}/390: 권한 버튼이 칸 안에`, buttons.every((b) => b.right <= 390), { buttons });
      await shot(page, `agent-one-390-${scheme}`);
      await context.close();
    }
    for (const scene of ["observer", "unavailable"]) {
      const { context, page } = await open(browser, origin, scheme, `agent-${scene}`);
      if (scene === "observer") {
        const n = await page.$$eval('[data-testid="agent-permission"] button', (els) => els.length);
        check(`${scheme}/observer: 권한 버튼 0`, n === 0, { n });
        const raw = await page.$$eval('[data-testid="agent-tool-card"] button', (els) => els.length);
        check(`${scheme}/observer: 원문 보기 0`, raw === 0, { raw });
      } else {
        const disabled = await page.$eval('[data-testid="agent-permission-allow"]', (e) => e.disabled);
        check(`${scheme}/unavailable: 허락 버튼 보이되 꺼짐`, disabled === true);
      }
      await shot(page, `agent-${scene}-1280-${scheme}`);
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ viewport: DESKTOP, colorScheme: "light", reducedMotion: "reduce" });
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(`${origin}/#/design/local-terminal?scene=agent-long`);
    await page.getByTestId("agent-pane").waitFor();
    const cards = await page.$$eval('[data-testid="agent-tool-card"]', (els) => els.length);
    const ms = Date.now() - t0;
    check("long: 604 카드(고정 4 + 600)가 그려진다", cards === 604, { cards, ms });
    const scrollMs = await page.evaluate(async () => {
      const scroller = document.querySelector('[data-testid="agent-pane-feed"]').parentElement;
      const start = performance.now();
      for (let i = 0; i < 20; i += 1) {
        scroller.scrollTop = (scroller.scrollHeight / 20) * i;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return performance.now() - start;
    });
    check("long: 스크롤 20 프레임 1초 안", scrollMs < 1000, { scrollMs: Math.round(scrollMs) });
    await shot(page, "agent-long-1280-light");
    await context.close();
  }
}

async function compare(browser) {
  if (!MOCKUP || !existsSync(MOCKUP)) {
    console.log("MOCKUP 없음: 비교 이미지는 건너뛴다");
    return;
  }
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(pathToFileURL(MOCKUP).href, { waitUntil: "load" });
    if (scheme === "dark") await page.evaluate(() => document.querySelector("#d5")?.classList.add("dark"));
    const panel = page.locator("#d5 aside.tpanel");
    await panel.scrollIntoViewIfNeeded();
    const mock = await panel.screenshot();
    const impl = readFileSync(resolve(OUT_DIR, `agent-tab-1280-${scheme}.png`));
    const bg = scheme === "dark" ? "#111214" : "#e8e8eb";
    const fg = scheme === "dark" ? "#ededf0" : "#18181b";
    const html = `<!doctype html><html><body style="margin:0;background:${bg};font:14px -apple-system,sans-serif;color:${fg}">
      <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
        <figure style="margin:0"><figcaption style="margin-bottom:8px">시안 ⑤ 스레드 root 카드 (${scheme})</figcaption>
          <img style="width:420px" src="data:image/png;base64,${mock.toString("base64")}"></figure>
        <figure style="margin:0"><figcaption style="margin-bottom:8px">구현 #2779 「내 작업」 A 칸 (${scheme})</figcaption>
          <img style="width:1100px" src="data:image/png;base64,${impl.toString("base64")}"></figure>
      </div></body></html>`;
    const sheet = await context.newPage();
    await sheet.setContent(html, { waitUntil: "load" });
    await sheet.screenshot({ path: resolve(OUT_DIR, `compare-agent-pane-${scheme}.png`), fullPage: true });
    report.scenes.push(`compare-agent-pane-${scheme}`);
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ 가 없다. npm run capture:agent-pane 으로 build:design 부터 돌린다.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  try {
    const browser = await chromium.launch();
    try {
      await scenes(browser, preview.origin);
      await compare(browser);
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
