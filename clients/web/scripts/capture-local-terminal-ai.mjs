#!/usr/bin/env node
// =============================================================================
// 로컬 터미널 새 세션이 기본 AI 선택을 따르는 모습 캡처 (#3010).
//
//   npm run build:design && node scripts/capture-local-terminal-ai.mjs
//
// 브라우저 하네스(`#/design/local-terminal?scene=ai-*`)는 이 맥의 감지와 프로필 목록을
// 고정 값으로 둔다. 로컬 터미널 선택은 「Claude · 개인」.
//   - ai-account: 새 세션 메뉴에 고른 계정이 보인다.
//   - ai-missing: 그 계정이 목록에 없다 → Claude를 고르면 표와 같은 문장 + 셸.
//   - ai-login: 그 계정이 로그인 필요 → 같은 모양.
// 라이트·다크 × 1280·390 → captures/3010/*.png
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "captures/3010");
const PORT = Number(process.env.CAPTURE_PORT || 5310);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const FRAMES = [
  { viewport: { width: 1280, height: 800 }, scheme: "light" },
  { viewport: { width: 1280, height: 800 }, scheme: "dark" },
  { viewport: { width: 390, height: 844 }, scheme: "light" },
  { viewport: { width: 390, height: 844 }, scheme: "dark" },
];

async function openMenu(page) {
  await page.getByTestId("local-terminal-new").click();
  await page.getByTestId("local-terminal-new-claude").waitFor({ state: "visible" });
}

const SCENES = [
  {
    name: "dock-account-menu",
    scene: "ai-account",
    act: async (page) => {
      await openMenu(page);
      await page.getByTestId("local-terminal-new-claude-account").waitFor({ state: "visible" });
    },
  },
  {
    name: "dock-missing-notice",
    scene: "ai-missing",
    act: async (page) => {
      await openMenu(page);
      await page.getByTestId("local-terminal-new-claude").click();
      await page.getByTestId("workbench-notice").filter({ hasText: "목록에 없어" }).waitFor();
    },
  },
  {
    name: "dock-login-notice",
    scene: "ai-login",
    act: async (page) => {
      await openMenu(page);
      await page.getByTestId("local-terminal-new-claude").click();
      await page.getByTestId("workbench-notice").filter({ hasText: "로그인 필요" }).waitFor();
    },
  },
];

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build:design` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  process.on("exit", () => server.kill("SIGTERM"));
  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      for (const scene of SCENES) {
        for (const frame of FRAMES) {
          const context = await browser.newContext({
            viewport: frame.viewport,
            deviceScaleFactor: 2,
            colorScheme: frame.scheme,
            reducedMotion: "reduce",
          });
          const page = await context.newPage();
          await page.goto(`${ORIGIN}/#/design/local-terminal?scene=${scene.scene}`);
          await page.getByTestId("local-terminal-new").waitFor({ state: "visible" });
          await scene.act(page);
          await page.waitForTimeout(300);
          const path = `${OUT_DIR}/${scene.name}-${frame.viewport.width}-${frame.scheme}.png`;
          await page.screenshot({ path });
          console.log(path);
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
