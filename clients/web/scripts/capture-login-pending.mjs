#!/usr/bin/env node
// CAPTURE: 로그인 「들어가기」 요청 중 / 시간 초과 / 연결 실패 (#3267).
// 게이트가 아니라 증거다. `npm run build` 뒤에 돌린다.
//   OUT_DIR=captures/3267 node scripts/capture-login-pending.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.LOGIN_CAPTURE_PORT || 5193);
const origin = `http://127.0.0.1:${port}`;
const outDir = resolve(process.env.OUT_DIR || resolve(webRoot, "captures/3267"));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("preview server did not start");
}

async function shoot(browser, scheme, viewport, tag) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  let loginCalls = 0;
  await page.clock.install();
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") {
      loginCalls += 1;
      return; // 응답하지 않는다 = 대기 중
    }
    return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
  });
  await page.goto(origin);
  await page.getByTestId("connect-entry-submit").click(); // 웹: 빈 칸 = 이 페이지의 서버
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("correct-horse-battery");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("login-submit").click({ force: true });
  await page.getByTestId("login-submit").click({ force: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outDir, `pending-${tag}-${scheme}.png`) });
  console.log(`${tag} ${scheme}: login requests after 3 clicks = ${loginCalls}`);
  await page.clock.fastForward(16_000);
  await page.getByTestId("login-error").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(outDir, `timeout-${tag}-${scheme}.png`) });
  console.log(`${tag} ${scheme}: ${await page.getByTestId("login-error").innerText()}`);
  await context.close();
}

mkdirSync(outDir, { recursive: true });
if (!existsSync(resolve(webRoot, "dist/index.html"))) throw new Error("run npm run build first");
const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: webRoot,
  stdio: "ignore",
});
try {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      await shoot(browser, scheme, { width: 1280, height: 800 }, "1280");
      await shoot(browser, scheme, { width: 390, height: 844 }, "390");
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}
