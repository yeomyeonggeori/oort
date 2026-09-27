#!/usr/bin/env node
// =============================================================================
// 설정 › AI 연결 — 내 계정 줄과 재진입 복귀 (#2938 ①·③).
//
//   npm run build:design && node scripts/capture-ai-connect-return.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-ai-connect-return.mjs
//   ONLY=loop node scripts/capture-ai-connect-return.mjs   # ③만
//
// ① 내 계정 · 이 맥: AI 연결 화면이 「준비됨」으로 읽는 CLI가 같은 알약으로 선다.
//    브라우저에는 이 맥의 CLI가 없어 design 전용 `?aiEntry=rows&aiProbe=claude-ready`
//    로 감지 결과를 세운다(제품 빌드는 두 값을 늘 무시한다).
// ③ 채널 → 설정 AI 절 → 「구독 추가」(재진입) → [뒤로] → 「앱으로 돌아가기」가 채널로
//    나가는지 실제 번들로 몬다. 끝 코드는 루프가 남아 있으면 1이다.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5194);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};
const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function installMocks(context) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, { accessToken: SESSION.accessToken, refreshToken: SESSION.refreshToken })
  );
  await context.route("**/v1/workspaces/*/channels", (route) => json(route, { channels: CHANNELS }));
  await context.route("**/v1/workspaces/*/roster", (route) => json(route, { members: [] }));
  // 운영자가 아닌 사람의 팀 연결(403 → 운영자 안내). 내 계정 절만 본다.
  await context.route("**/v1/provider/link**", (route) =>
    json(route, { error: { code: "forbidden", message: "operator required" } }, 403)
  );
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`preview server never came up: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function signedIn(browser, { viewport, scheme }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  return { context, page };
}

async function accounts(browser, frame) {
  const { context, page } = await signedIn(browser, frame);
  await page.evaluate(() => {
    location.hash = "/settings?section=ai&aiEntry=rows&aiProbe=claude-ready";
  });
  await page.getByTestId("my-account-claude").waitFor({ state: "visible" });
  await page.getByTestId("ai-my-accounts").scrollIntoViewIfNeeded();
  const path = `${OUT_DIR}/ai-my-accounts-ready-${frame.viewport.width}-${frame.scheme}.png`;
  await page.screenshot({ path });
  const pill = await page.getByTestId("my-account-claude-state").textContent();
  await context.close();
  return { path, pill };
}

async function loop(browser) {
  const { context, page } = await signedIn(browser, {
    viewport: { width: 1280, height: 800 },
    scheme: "light",
  });
  const trail = [];
  const at = async (label) => trail.push(`${label}: ${await page.evaluate(() => location.hash)}`);
  await at("start");
  await page.evaluate(() => {
    location.hash = "/settings?section=ai&aiEntry=rows";
  });
  await page.getByTestId("subscription-entry-open").click();
  await page.getByTestId("ai-connect-reentry-layer").waitFor({ state: "visible" });
  await at("reentry");
  await page.getByTestId("ai-connect-reentry-back").click();
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  await page.getByTestId("ai-connect-reentry-layer").waitFor({ state: "detached" });
  await at("back-to-settings");
  await page.getByTestId("settings-back-to-app").click();
  await page.waitForTimeout(600);
  await at("after-back-to-app");
  const reentry = await page.getByTestId("ai-connect-reentry-layer").count();
  const settings = await page.getByTestId("settings-route").count();
  const channel = await page.getByTestId("channel-list").isVisible();
  const path = `${OUT_DIR}/ai-connect-return-after-back-to-app-1280-light.png`;
  await page.screenshot({ path });
  await context.close();
  return { trail, ok: reentry === 0 && settings === 0 && channel, path };
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
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);
  let ok = true;
  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      const only = process.env.ONLY ?? "";
      for (const frame of only === "loop" ? [] : [
        { viewport: { width: 1280, height: 800 }, scheme: "light" },
        { viewport: { width: 390, height: 844 }, scheme: "dark" },
      ]) {
        const shot = await accounts(browser, frame);
        console.log(JSON.stringify({ scene: "accounts", ...shot }));
        if (shot.pill !== "준비됨") ok = false;
      }
      const result = await loop(browser);
      console.log(JSON.stringify({ scene: "loop", ...result }));
      if (!result.ok) ok = false;
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
  console.log(ok ? "AI-CONNECT-RETURN PASS" : "AI-CONNECT-RETURN FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
